#!/usr/bin/env python3
"""Build a resumable, provenance-preserving luxury product image library.

Uses only Python's standard library so it can run from a clean checkout:
  python scripts/download_luxury_image_library.py
"""
from __future__ import annotations

import argparse, csv, hashlib, html, json, mimetypes, os, re, shutil, sys, time, urllib.error, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
NS = {"x": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
UA = "Mozilla/5.0 (compatible; FeedaccountImageLibrary/1.0; +local-asset-download)"
IMAGE_MAGIC = ((b"\xff\xd8\xff", ".jpg"), (b"\x89PNG\r\n\x1a\n", ".png"), (b"GIF87a", ".gif"), (b"GIF89a", ".gif"), (b"RIFF", ".webp"))
LOCK = Lock()
NON_PRODUCT_URL = re.compile(r"(?:favicon|/logo(?:/|\\.|_)|/icons?/)" , re.I)

def clean_part(value: str, fallback: str) -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", (value or "").strip())
    value = re.sub(r"\s+", " ", value).strip(" .")
    return value[:100] or fallback

def read_xlsx_rows(path: Path, sheet_name: str):
    with ZipFile(path) as book:
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            strings = ["".join(t.text or "" for t in cell.iterfind(".//x:t", NS)) for cell in root.findall("x:si", NS)]
        workbook = ET.fromstring(book.read("xl/workbook.xml"))
        rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"].lstrip("/") for r in rels}
        sheet = next(s for s in workbook.findall("x:sheets/x:sheet", NS) if s.attrib["name"] == sheet_name)
        target = targets[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
        root = ET.fromstring(book.read(target))
        output = []
        for row in root.findall(".//x:sheetData/x:row", NS):
            values = {}
            for cell in row.findall("x:c", NS):
                ref = cell.attrib.get("r", "A1")
                col = re.match(r"[A-Z]+", ref).group(0)
                value = cell.findtext("x:v", default="", namespaces=NS)
                if cell.attrib.get("t") == "s" and value: value = strings[int(value)]
                values[col] = value
            output.append(values)
        return output

def col_index(name: str) -> int:
    n = 0
    for ch in name: n = n * 26 + ord(ch) - 64
    return n - 1

def xlsx_manifest(source: Path):
    rows = read_xlsx_rows(source, "500真实SKU库")
    header_at = next(i for i, r in enumerate(rows) if r.get("A") == "SKU ID")
    cols = {v: col_index(k) for k, v in rows[header_at].items()}
    def value(row, label):
        idx = cols[label]
        return row.get(chr(65 + idx), "")
    result = []
    for row in rows[header_at + 1:]:
        sku = value(row, "SKU ID")
        if not sku: continue
        direct, page = value(row, "官方主图直链"), value(row, "官网商品URL")
        result.append({"sku_id": sku, "brand": value(row, "Brand"), "category": value(row, "Category"), "product": value(row, "Product"), "sku_ref": value(row, "SKU / Ref"), "original_url": direct or page, "declared_image_url": direct, "product_page_url": page, "source_link_type": value(row, "主图链接类型"), "classification_note": "" if value(row,"Brand") and value(row,"Category") else "brand_or_category_missing: conservative fallback used"})
    return result

def fetch(url, timeout, binary=True):
    request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.geturl(), response.headers.get_content_type(), response.read()

def urls_from_page(page: str, base: str, rule: dict):
    candidates = []
    def add(value, score):
        if not value or value.startswith("data:"): return
        value = html.unescape(value.strip())
        if value.startswith("//"): value = "https:" + value
        absolute = urllib.parse.urljoin(base, value)
        # A site shell icon is a valid raster image but never a product image.
        if absolute.startswith("http") and not NON_PRODUCT_URL.search(urllib.parse.urlparse(absolute).path): candidates.append((score, absolute))
    for prop in ("og:image", "og:image:secure_url", "twitter:image"):
        for value in re.findall(r'<meta[^>]+(?:property|name)=["\']' + re.escape(prop) + r'["\'][^>]+content=["\']([^"\']+)', page, re.I): add(value, 100)
    attrs = rule.get("preferred_attributes", []) + ["data-zoom-image", "data-src", "data-original", "data-lazy-src", "srcset", "src"]
    for attr in dict.fromkeys(attrs):
        for value in re.findall(r'\b' + re.escape(attr) + r'=["\']([^"\']+)', page, re.I):
            if attr == "srcset":
                for piece in value.split(","):
                    bits = piece.strip().split()
                    if bits: add(bits[0], 30 + (int(re.sub(r"\D", "", bits[-1]) or 0) // 100 if len(bits)>1 else 0))
            else: add(value, 50)
    for value in re.findall(r'"(?:image|imageUrl|image_url|zoomImage)"\s*:\s*"([^"]+)"', page, re.I): add(value.replace("\\/", "/"), 80)
    return [u for _, u in sorted(set(candidates), reverse=True)]

def extension(content_type, content, url):
    for magic, ext in IMAGE_MAGIC:
        if content.startswith(magic): return ext
    guessed = mimetypes.guess_extension(content_type or "")
    if guessed in (".jpg", ".jpeg", ".png", ".webp", ".gif"): return ".jpg" if guessed == ".jpeg" else guessed
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    return suffix if suffix in (".jpg", ".jpeg", ".png", ".webp", ".gif") else ".img"

def download_one(item, out, rules, timeout, retries):
    brand, category = clean_part(item["brand"], "_unclassified_brand"), clean_part(item["category"], "_unclassified_category")
    base = out / "images" / brand / category
    base.mkdir(parents=True, exist_ok=True)
    attempted, errors = [], []
    urls = [item["declared_image_url"]] if item["declared_image_url"] else []
    if item["product_page_url"] and item["product_page_url"] not in urls: urls.append(item["product_page_url"])
    for source_url in urls:
        host = urllib.parse.urlparse(source_url).netloc.lower()
        for attempt in range(retries + 1):
            try:
                final_url, content_type, body = fetch(source_url, timeout)
                attempted.append(final_url)
                if content_type.startswith("image/") or any(body.startswith(m) for m, _ in IMAGE_MAGIC):
                    digest = hashlib.sha256(body).hexdigest()
                    ext = extension(content_type, body, final_url)
                    destination = base / f"{clean_part(item['sku_id'], 'unknown')}_{digest[:12]}{ext}"
                    if not destination.exists(): destination.write_bytes(body)
                    return {**item, "final_image_url": final_url, "status": "downloaded", "local_path": str(destination.relative_to(ROOT)), "sha256": digest, "failure_reason": "", "attempted_urls": attempted}
                # Landing page: first use a domain's previously learned attributes, then generic parsing.
                page = body.decode("utf-8", errors="replace")
                rule = rules.get(host, {})
                image_urls = urls_from_page(page, final_url, rule)
                if image_urls:
                    with LOCK: rules[host] = {"preferred_attributes": ["data-zoom-image", "data-src", "data-original", "data-lazy-src", "srcset", "src"], "page_rule": "og/twitter meta, JSON image fields, then lazy-load/srcset/src", "last_success_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "last_page_url": final_url}
                    # Resolve candidates immediately; changing ``urls`` would not alter
                    # Python's active for-loop iterator and used to lose page-only SKUs.
                    for image_url in image_urls:
                        try:
                            image_final, image_type, image_body = fetch(image_url, timeout)
                            attempted.append(image_final)
                            if not (image_type.startswith("image/") or any(image_body.startswith(m) for m, _ in IMAGE_MAGIC)):
                                continue
                            digest = hashlib.sha256(image_body).hexdigest()
                            ext = extension(image_type, image_body, image_final)
                            destination = base / f"{clean_part(item['sku_id'], 'unknown')}_{digest[:12]}{ext}"
                            if not destination.exists(): destination.write_bytes(image_body)
                            return {**item, "final_image_url": image_final, "status": "downloaded", "local_path": str(destination.relative_to(ROOT)), "sha256": digest, "failure_reason": "", "attempted_urls": attempted}
                        except Exception as image_exc:
                            errors.append(f"candidate {type(image_exc).__name__}: {image_exc}")
                    raise ValueError("landing page candidates were not retrievable as images")
                raise ValueError(f"landing page yielded no supported image candidates (content-type {content_type})")
            except Exception as exc:
                errors.append(f"{type(exc).__name__}: {exc}")
                if attempt < retries: time.sleep(1.0 * (attempt + 1))
        else: continue
    return {**item, "final_image_url": "", "status": "failed", "local_path": "", "sha256": "", "failure_reason": " | ".join(errors)[-2000:], "attempted_urls": attempted}

def atomic_json(path, value):
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)

def prior_download_is_usable(record):
    """Do not trust a stale index entry just because it says downloaded."""
    local = record.get("local_path", "")
    url = record.get("final_image_url", "")
    path = ROOT / local
    return bool(local and path.is_file() and path.stat().st_size >= 10_000 and not NON_PRODUCT_URL.search(urllib.parse.urlparse(url).path))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=ROOT / "500_luxury_verified_sku_image_links.xlsx")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "luxury-image-library")
    parser.add_argument("--workers", type=int, default=6); parser.add_argument("--timeout", type=int, default=20); parser.add_argument("--retries", type=int, default=2); parser.add_argument("--limit", type=int)
    parser.add_argument("--override-image", action="append", default=[], metavar="SKU_ID=URL", help="Retry one SKU with a verified product-image URL while preserving its original source URL")
    args = parser.parse_args(); out = args.output; out.mkdir(parents=True, exist_ok=True)
    rules_path, index_path = out / "domain_rules.json", out / "image_index.json"
    rules = json.loads(rules_path.read_text(encoding="utf-8")) if rules_path.exists() else {}
    existing = {x["sku_id"]: x for x in json.loads(index_path.read_text(encoding="utf-8"))} if index_path.exists() else {}
    manifest = xlsx_manifest(args.source); atomic_json(out / "source_manifest.json", manifest)
    overrides = {}
    for value in args.override_image:
        sku, separator, url = value.partition("=")
        if not separator or not sku or not url.startswith("http"):
            parser.error("--override-image must be SKU_ID=https://verified-product-image")
        overrides[sku] = url
    if overrides:
        found = set()
        for item in manifest:
            if item["sku_id"] in overrides:
                item["declared_image_url"] = overrides[item["sku_id"]]
                item["source_link_type"] = "browser-verified product image override"
                found.add(item["sku_id"])
        unknown = set(overrides) - found
        if unknown: parser.error("unknown SKU ID(s): " + ", ".join(sorted(unknown)))
    todo = [x for x in manifest if not (existing.get(x["sku_id"], {}).get("status") == "downloaded" and prior_download_is_usable(existing[x["sku_id"]]))]
    if overrides: todo = [x for x in todo if x["sku_id"] in overrides]
    if args.limit: todo = todo[:args.limit]
    print(f"Manifest: {len(manifest)} SKU; queued: {len(todo)}; output: {out}", flush=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(download_one, item, out, rules, args.timeout, args.retries) for item in todo]
        for num, future in enumerate(as_completed(futures), 1):
            result = future.result(); existing[result["sku_id"]] = result
            if num % 10 == 0 or result["status"] == "failed": print(f"{num}/{len(todo)} {result['sku_id']} {result['status']}", flush=True)
            if num % 20 == 0: atomic_json(index_path, [existing[x["sku_id"]] for x in manifest if x["sku_id"] in existing]); atomic_json(rules_path, rules)
    ordered = [existing[x["sku_id"]] for x in manifest if x["sku_id"] in existing]
    atomic_json(index_path, ordered); atomic_json(rules_path, rules)
    fields = ["sku_id","brand","category","product","sku_ref","original_url","declared_image_url","product_page_url","final_image_url","status","local_path","sha256","failure_reason","classification_note","source_link_type","attempted_urls"]
    with (out / "image_index.csv").open("w", newline="", encoding="utf-8-sig") as file:
        writer = csv.DictWriter(file, fieldnames=fields); writer.writeheader()
        for row in ordered: writer.writerow({**row, "attempted_urls": json.dumps(row.get("attempted_urls", []), ensure_ascii=False)})
    count = {state: sum(x["status"] == state for x in ordered) for state in ("downloaded", "failed")}
    print("Complete:", count, "rules:", len(rules), flush=True)

if __name__ == "__main__": main()
