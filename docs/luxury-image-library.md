# 奢侈品产品图片库

运行 `python scripts/download_luxury_image_library.py` 会从根目录的 `500_luxury_verified_sku_image_links.xlsx` 建立或续跑图片库。

输出位于 `data/luxury-image-library/`：

- `images/<品牌>/<类别>/`：实际下载的官方图片；已有文件不会覆盖。
- `image_index.json` 与 `image_index.csv`：每个 SKU 的原始链接、最终图片链接、状态、本地路径、分类、哈希和失败原因。
- `domain_rules.json`：按官网域名积累的图片提取规则；下一次先复用该规则，再回退至通用解析。
- `source_manifest.json`：由原始工作簿提取的 500 个 SKU 清单。

脚本默认 6 个并发、20 秒超时、每个请求重试 2 次。中断后再次执行即可跳过索引中已验证存在的下载；可用 `--workers 3 --timeout 30` 降低请求强度，或用 `--limit 10` 做小批验证。
