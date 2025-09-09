import argparse, os, glob
import cv2
import numpy as np

try:
    import torch
    import torchvision.transforms as T
    from torchvision.transforms.functional import resize
    _HAS_TORCH = True
except Exception:
    _HAS_TORCH = False

# Minimal stub using OpenCV gray if torch not present

def save_depth_like(img_path, out_path):
    img = cv2.imread(img_path)
    if img is None:
        return
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    depth = cv2.GaussianBlur(gray, (0,0), 7)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cv2.imwrite(out_path, depth)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    images = []
    for ext in ('*.jpg','*.png','*.jpeg'):
        images.extend(glob.glob(os.path.join(args.input, ext)))

    for p in images:
        base = os.path.basename(p)
        out = os.path.join(args.output, base)
        save_depth_like(p, out)
        print('wrote', out)

if __name__ == '__main__':
    main()
