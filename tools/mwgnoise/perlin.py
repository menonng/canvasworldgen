"""Vectorised re-implementation of Minecraft's Perlin noise stack.

``ImprovedNoise`` / ``PerlinNoise`` / ``NormalNoise`` follow
``net.minecraft.world.level.levelgen.synth`` exactly, but evaluate on numpy
arrays so a whole heightmap can be sampled at once.
"""

from __future__ import annotations

import numpy as np

from .mcrandom import Xoroshiro

# SimplexNoise.GRADIENT
GRADIENT = np.array(
    [
        [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
        [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
        [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
        [1, 1, 0], [0, -1, 1], [-1, 1, 0], [0, -1, -1],
    ],
    dtype=np.float64,
)

_WRAP_PERIOD = 3.3554432e7


def _smoothstep(t):
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0)


def _wrap(v):
    return v - np.floor(v / _WRAP_PERIOD + 0.5) * _WRAP_PERIOD


class ImprovedNoise:
    __slots__ = ("xo", "yo", "zo", "p")

    def __init__(self, random: Xoroshiro):
        self.xo = random.next_double() * 256.0
        self.yo = random.next_double() * 256.0
        self.zo = random.next_double() * 256.0
        p = list(range(256))
        for i in range(256):
            j = random.next_int(256 - i)
            p[i], p[i + j] = p[i + j], p[i]
        self.p = np.array(p, dtype=np.int64)

    def _p(self, idx):
        return self.p[idx & 255]

    def noise(self, x, y, z):
        """``noise(x, y, z, 0, 0)`` — the form used by PerlinNoise."""
        d = np.asarray(x, dtype=np.float64) + self.xo
        e = np.asarray(y, dtype=np.float64) + self.yo
        f = np.asarray(z, dtype=np.float64) + self.zo
        d, e, f = np.broadcast_arrays(d, e, f)

        gx = np.floor(d).astype(np.int64)
        gy = np.floor(e).astype(np.int64)
        gz = np.floor(f).astype(np.int64)
        dx = d - gx
        dy = e - gy
        dz = f - gz

        i = self._p(gx)
        j = self._p(gx + 1)
        k = self._p(i + gy)
        l = self._p(i + gy + 1)
        m = self._p(j + gy)
        n = self._p(j + gy + 1)

        def grad_dot(idx, ax, ay, az):
            g = GRADIENT[idx & 15]
            return g[..., 0] * ax + g[..., 1] * ay + g[..., 2] * az

        v000 = grad_dot(self._p(k + gz), dx, dy, dz)
        v100 = grad_dot(self._p(m + gz), dx - 1.0, dy, dz)
        v010 = grad_dot(self._p(l + gz), dx, dy - 1.0, dz)
        v110 = grad_dot(self._p(n + gz), dx - 1.0, dy - 1.0, dz)
        v001 = grad_dot(self._p(k + gz + 1), dx, dy, dz - 1.0)
        v101 = grad_dot(self._p(m + gz + 1), dx - 1.0, dy, dz - 1.0)
        v011 = grad_dot(self._p(l + gz + 1), dx, dy - 1.0, dz - 1.0)
        v111 = grad_dot(self._p(n + gz + 1), dx - 1.0, dy - 1.0, dz - 1.0)

        s = _smoothstep(dx)
        t = _smoothstep(dy)
        u = _smoothstep(dz)

        x00 = v000 + s * (v100 - v000)
        x10 = v010 + s * (v110 - v010)
        x01 = v001 + s * (v101 - v001)
        x11 = v011 + s * (v111 - v011)
        y0 = x00 + t * (x10 - x00)
        y1 = x01 + t * (x11 - x01)
        return y0 + u * (y1 - y0)


class PerlinNoise:
    """``PerlinNoise.create(random, firstOctave, amplitudes)``."""

    __slots__ = ("first_octave", "amplitudes", "levels", "input_factor", "value_factor")

    def __init__(self, random: Xoroshiro, first_octave: int, amplitudes: list[float]):
        self.first_octave = first_octave
        self.amplitudes = list(amplitudes)
        count = len(self.amplitudes)
        factory = random.fork_positional()
        self.levels: list[ImprovedNoise | None] = []
        for k in range(count):
            if self.amplitudes[k] != 0.0:
                self.levels.append(ImprovedNoise(factory.from_hash_of(f"octave_{first_octave + k}")))
            else:
                self.levels.append(None)
        self.input_factor = 2.0**first_octave
        self.value_factor = (2.0 ** (count - 1)) / (2.0**count - 1.0)

    def value(self, x, y, z):
        total = 0.0
        in_f = self.input_factor
        val_f = self.value_factor
        for amp, level in zip(self.amplitudes, self.levels):
            if level is not None:
                total = total + amp * val_f * level.noise(
                    _wrap(np.asarray(x, dtype=np.float64) * in_f),
                    _wrap(np.asarray(y, dtype=np.float64) * in_f),
                    _wrap(np.asarray(z, dtype=np.float64) * in_f),
                )
            in_f *= 2.0
            val_f /= 2.0
        return total


class NormalNoise:
    """``NormalNoise.create(random, NoiseParameters)``."""

    INPUT_FACTOR = 1.0181268882175227

    __slots__ = ("first", "second", "value_factor")

    def __init__(self, random: Xoroshiro, first_octave: int, amplitudes: list[float]):
        self.first = PerlinNoise(random, first_octave, amplitudes)
        self.second = PerlinNoise(random, first_octave, amplitudes)
        lo = None
        hi = None
        for idx, amp in enumerate(amplitudes):
            if amp != 0.0:
                if lo is None:
                    lo = idx
                hi = idx
        if lo is None:
            lo = hi = 0
        self.value_factor = (1.0 / 6.0) / (0.1 * (1.0 + 1.0 / (hi - lo + 1)))

    def value(self, x, y, z):
        f = self.INPUT_FACTOR
        a = self.first.value(x, y, z)
        b = self.second.value(
            np.asarray(x, dtype=np.float64) * f,
            np.asarray(y, dtype=np.float64) * f,
            np.asarray(z, dtype=np.float64) * f,
        )
        return (a + b) * self.value_factor
