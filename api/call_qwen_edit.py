# 从另一台局域网电脑调用 ComfyUI 图片编辑 API 的示例代码
#
# 用法：
#   python call_qwen_edit.py --image 商品图.png --instruction "把背景换成纯白"
#
# 依赖：requests (pip install requests)

import requests
import sys
import argparse
import os
import time

# ── 配置 ────────────────────────────────
# 把这里改成 A 机（ComfyUI 所在机器）的局域网 IP
GATEWAY_URL = "http://192.168.x.x:39210"  # ← 改成实际 IP


def edit_image(image_path, instruction, megapixels=None):
    """调用 ComfyUI 网关，编辑图片"""
    url = f"{GATEWAY_URL}/api/comfyui/edit"
    
    files = {"image": (os.path.basename(image_path), open(image_path, "rb"), "image/png")}
    data = {"instruction": instruction}
    if megapixels:
        data["megapixels"] = str(megapixels)
    
    print(f"正在提交编辑请求...")
    print(f"  图片: {image_path}")
    print(f"  指令: {instruction}")
    
    start = time.time()
    response = requests.post(url, files=files, data=data, timeout=600)
    elapsed = time.time() - start
    
    if response.status_code != 200:
        print(f"错误 ({response.status_code}): {response.text}")
        return None
    
    # 保存结果
    result_filename = response.headers.get("X-Result-Filename", "result.png")
    output_path = os.path.join(os.path.dirname(image_path), "edited_" + result_filename)
    
    with open(output_path, "wb") as f:
        f.write(response.content)
    
    print(f"✅ 编辑完成！耗时 {elapsed:.1f}s")
    print(f"  结果已保存: {output_path}")
    print(f"  文件大小: {len(response.content) / 1024:.0f} KB")
    
    return output_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Qwen 图片编辑 API 调用工具")
    parser.add_argument("--image", required=True, help="输入图片路径")
    parser.add_argument("--instruction", required=True, help="编辑指令（中文/英文均可）")
    parser.add_argument("--megapixels", type=float, default=None, help="目标分辨率（百万像素，如 1.5）")
    
    args = parser.parse_args()
    
    result = edit_image(args.image, args.instruction, args.megapixels)
    if result:
        print(f"\n完成！")
