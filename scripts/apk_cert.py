#!/usr/bin/env python3
"""解析 APK v2/v3 签名块，输出签名证书指纹（纯标准库，无需 JDK/SDK）。

CI 门禁用法（输出首张证书的 SHA-256 大写十六进制，无冒号）:
    python3 scripts/apk_cert.py --digest <apk>

多 APK 对账用法（文件名 + scheme + 指纹前缀）:
    python3 scripts/apk_cert.py <apk> [<apk>...]

背景：.281-.292 的 CI 每版一张随机 runner 证书，覆盖安装全断；.293 起用入库
keystore（android/app/folia-release.p12），本脚本即 android-pre-release.yml 的指纹门禁。
"""
import sys, struct, hashlib

V2_SCHEME = 0x7109871A
V3_SCHEME = 0xF05368C0


def find_signing_block(data: bytes):
    """返回 pairs_dict。APK Signing Block 位于 Central Directory 之前，尾部 magic 固定。"""
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        raise ValueError("no EOCD")
    (cd_size, cd_off) = struct.unpack_from("<II", data, eocd + 12)
    if cd_off < 32 or data[cd_off - 16:cd_off] != b"APK Sig Block 42":
        raise ValueError("no APK signing block")
    block_size_tail = struct.unpack_from("<Q", data, cd_off - 24)[0]
    block_start = cd_off - block_size_tail - 8
    if struct.unpack_from("<Q", data, block_start)[0] != block_size_tail:
        raise ValueError("block size mismatch")
    pairs = {}
    off = block_start + 8
    pairs_end = cd_off - 24
    while off < pairs_end:
        (plen,) = struct.unpack_from("<Q", data, off)
        (pid,) = struct.unpack_from("<I", data, off + 8)
        pairs.setdefault(pid, []).append(data[off + 12: off + 8 + plen])
        off += 8 + plen
    return pairs


def first_certificate(pairs: dict) -> bytes:
    """v2/v3 signer: 长度前缀 signer -> signed data -> certificates 序列，取第一张。"""
    for pid in (V3_SCHEME, V2_SCHEME):
        if pid in pairs:
            val = pairs[pid][0]
            (signer_len,) = struct.unpack_from("<I", val, 0)
            signer = val[4: 4 + signer_len]
            (sd_len,) = struct.unpack_from("<I", signer, 0)
            sd = signer[4: 4 + sd_len]
            (d_len,) = struct.unpack_from("<I", sd, 0)
            (certs_len,) = struct.unpack_from("<I", sd, 4 + d_len)
            blob = sd[4 + d_len + 4: 4 + d_len + 4 + certs_len]
            (clen,) = struct.unpack_from("<I", blob, 0)
            return blob[4: 4 + clen]
    raise ValueError("no v2/v3 signature")


def digest(path: str) -> str:
    with open(path, "rb") as f:
        cert = first_certificate(find_signing_block(f.read()))
    return hashlib.sha256(cert).hexdigest().upper()


def main(argv):
    if argv and argv[0] == "--digest":
        print(digest(argv[1]))
        return
    for p in argv:
        try:
            with open(p, "rb") as f:
                data = f.read()
            pairs = find_signing_block(data)
            schemes = ["v2" if V2_SCHEME in pairs else "", "v3" if V3_SCHEME in pairs else ""]
            schemes = "+".join(s for s in schemes if s)
            print(f"{p}\t{schemes}\t{digest(p)[:16]}")
        except Exception as e:
            print(f"{p}\tERROR\t{e}")


if __name__ == "__main__":
    main(sys.argv[1:])
