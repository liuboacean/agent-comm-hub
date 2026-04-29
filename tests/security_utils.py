#!/usr/bin/env python3
"""security_utils.py — 测试用工具函数"""

import hashlib

def sha256(input_str: str) -> str:
    return hashlib.sha256(input_str.encode()).hexdigest()

def sanitize_path_test():
    """
    模拟 security.ts 中 sanitizePath 的逻辑进行测试。
    原始规则：
      - 不包含 '..'
      - 不以 '/' 开头
      - 不包含 '\\0'
    """
    def check(input_path: str) -> bool:
        normalized = input_path.replace("\\", "/")
        return (
            ".." not in normalized
            and not normalized.startswith("/")
            and "\x00" not in normalized
        )
    return {
        "normal": check("normal/path"),          # → True
        "traversal": check("../../etc/passwd"),   # → False
        "absolute": check("/absolute/path"),      # → False
        "null_byte": check("path\x00inject"),     # → False
    }
