"""Re-implementation of Minecraft's Xoroshiro128++ random source.

Mirrors ``net.minecraft.world.level.levelgen.XoroshiroRandomSource`` and
``RandomSupport`` so that noise generated here matches what the game produces
for a given world seed.
"""

from __future__ import annotations

import hashlib

MASK64 = (1 << 64) - 1
MASK32 = (1 << 32) - 1

GOLDEN_RATIO_64 = 0x9E3779B97F4A7C15
SILVER_RATIO_64 = 0x6A09E667F3BCC909


def _u64(v: int) -> int:
    return v & MASK64


def _s64(v: int) -> int:
    v &= MASK64
    return v - (1 << 64) if v >> 63 else v


def _rotl(v: int, k: int) -> int:
    v &= MASK64
    return ((v << k) | (v >> (64 - k))) & MASK64


def mix_stafford13(x: int) -> int:
    x = _u64(x)
    x = _u64((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9)
    x = _u64((x ^ (x >> 27)) * 0x94D049BB133111EB)
    return _u64(x ^ (x >> 31))


def upgrade_seed_to_128bit(seed: int) -> tuple[int, int]:
    """``RandomSupport.upgradeSeedTo128bit``."""
    lo = _u64(seed ^ SILVER_RATIO_64)
    hi = _u64(lo + GOLDEN_RATIO_64)
    return mix_stafford13(lo), mix_stafford13(hi)


def mth_get_seed(x: int, y: int, z: int) -> int:
    """``Mth.getSeed`` — the positional scramble used by ``at(x, y, z)``."""
    v = _s64(_s64(x * 3129871) ^ _s64(z * 116129781) ^ y)
    v = _s64(_s64(_s64(v * v) * 42317861) + _s64(v * 11))
    return v >> 16  # arithmetic shift, Python ints are already signed here


class Xoroshiro:
    """``XoroshiroRandomSource``."""

    __slots__ = ("lo", "hi")

    def __init__(self, lo: int, hi: int):
        lo = _u64(lo)
        hi = _u64(hi)
        if lo == 0 and hi == 0:
            lo, hi = GOLDEN_RATIO_64, SILVER_RATIO_64
        self.lo = lo
        self.hi = hi

    @classmethod
    def from_seed(cls, seed: int) -> "Xoroshiro":
        lo, hi = upgrade_seed_to_128bit(seed)
        return cls(lo, hi)

    def next_long(self) -> int:
        lo, hi = self.lo, self.hi
        result = _u64(_rotl(_u64(lo + hi), 17) + lo)
        hi ^= lo
        self.lo = _rotl(lo, 49) ^ hi ^ _u64(hi << 21)
        self.hi = _rotl(hi, 28)
        return result

    def next_bits(self, bits: int) -> int:
        return self.next_long() >> (64 - bits)

    def next_int(self, bound: int | None = None) -> int:
        if bound is None:
            return _s64(self.next_long()) & MASK32  # int cast of the low 32 bits
        if bound <= 0:
            raise ValueError("bound must be positive")
        # XoroshiroRandomSource.nextInt(int)
        value = self.next_long() & MASK32
        product = value * bound
        low = product & MASK32
        if low < bound:
            threshold = ((~bound + 1) & MASK32) % bound
            while low < threshold:
                value = self.next_long() & MASK32
                product = value * bound
                low = product & MASK32
        return product >> 32

    def next_double(self) -> float:
        return (self.next_long() >> 11) * (1.0 / (1 << 53))

    def consume(self, count: int) -> None:
        for _ in range(count):
            self.next_long()

    def fork_positional(self) -> "PositionalRandomFactory":
        return PositionalRandomFactory(self.next_long(), self.next_long())


class PositionalRandomFactory:
    """``XoroshiroRandomSource.XoroshiroPositionalRandomFactory``."""

    __slots__ = ("lo", "hi")

    def __init__(self, lo: int, hi: int):
        self.lo = _u64(lo)
        self.hi = _u64(hi)

    def at(self, x: int, y: int, z: int) -> Xoroshiro:
        seed = mth_get_seed(x, y, z)
        return Xoroshiro(_u64(seed) ^ self.lo, self.hi)

    def from_hash_of(self, name: str) -> Xoroshiro:
        # Guava's Hashing.md5().hashUnencodedChars(name) hashes the Java chars
        # as little-endian UTF-16 code units.
        digest = hashlib.md5(name.encode("utf-16-le")).digest()
        lo = int.from_bytes(digest[0:8], "big")
        hi = int.from_bytes(digest[8:16], "big")
        return Xoroshiro(lo ^ self.lo, hi ^ self.hi)

    def from_seed(self, seed: int) -> Xoroshiro:
        return Xoroshiro(seed ^ self.lo, self.hi)
