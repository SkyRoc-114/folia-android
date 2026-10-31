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


def _u32(buf: bytes, off: int) -> int:
    return struct.unpack_from("<I", buf, off)[0]


def _field(buf: bytes, off: int, what: str):
    """读一个长度前缀字段：[uint32 长度（不含自身 4 字节）][内容]，返回 (内容, 下一偏移)。
    .293 首跑教训：把这里当 TLV 自含长度解析，逐层错位后仍能取到「看似合理」的字节，
    算出格式良好但完全错误的指纹。"""
    n = _u32(buf, off)
    if n < 0 or off + 4 + n > len(buf):
        raise ValueError(f"{what} framing mismatch")
    return buf[off + 4: off + 4 + n], off + 4 + n


def first_certificate(pairs: dict) -> bytes:
    """v2/v3 签名块取第一张证书 DER。层级（每层 [长度不含自身][内容]）：
    value → signers 序列（单 signer 必须恰好耗尽）→ signer → signed data →
    digests → certificates → cert1。signed data 尾部（additional attributes 及
   其对齐）不强校验——只逐层校验我们走过的地方。"""
    for pid in (V3_SCHEME, V2_SCHEME):
        if pid not in pairs:
            continue
        val = pairs[pid][0]
        signers, off = _field(val, 0, "signers")
        if off != len(val):
            raise ValueError("signers trailing bytes")
        signer, _ = _field(signers, 0, "signer")
        signed_data, _ = _field(signer, 0, "signed data")
        _, off = _field(signed_data, 0, "digests")
        certs, _ = _field(signed_data, off, "certificates")
        cert, _ = _field(certs, 0, "certificate")
        if not cert.startswith(b"\x30\x82"):
            raise ValueError("certificate not DER")
        return cert
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
