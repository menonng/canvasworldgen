# MineWorldGen

**Minecraft Java 26.2 · 데이터팩 · 바닐라 바이옴 전용 지형 생성 프레임워크**

`config.json` 하나로 대륙·바다·섬·산맥·해안 지형을 원하는 대로 조절하는 월드 생성
데이터팩입니다. 블록과 바이옴은 **바닐라 요소만** 사용하며, 아무것도 건드리지 않으면
**바닐라와 100% 동일한 지형**이 생성됩니다.

A world generation data pack for Minecraft Java 26.2. Everything is driven by a
single `config.json`; only vanilla blocks and vanilla biomes are ever used; and
with the shipped defaults it generates terrain that is bit-for-bit identical to
vanilla.

![earthlike](docs/img/earthlike.png)

<sub>`presets/earthlike.json`, 57 344 × 57 344 blocks, seed 1234 — rendered by
`tools/render.py` from the pack's own JSON.</sub>

---

## 목차 / Contents

- [빠른 시작](#빠른-시작--quick-start)
- [바닐라 폴백](#바닐라-폴백--the-vanilla-fallback)
- [추천 프리셋](#추천-프리셋--recommended-presets)
- [설정 항목 전체](#설정-항목-전체--full-config-reference)
- [생성되는 지형](#생성되는-지형--what-the-terrain-system-produces)
- [작동 원리](#작동-원리--how-it-works)
- [실측 결과](#실측-결과--measured-results)
- [한계와 주의사항](#한계와-주의사항--limits-and-caveats)
- [개발 도구](#개발-도구--tooling)
- [크레딧](#크레딧--credits)

---

## 빠른 시작 / Quick start

**요구 사항 / Requirements** — Minecraft Java Edition **26.2** (data pack format
107). 모드는 필요 없습니다. 설정을 바꿀 때만 Python 3.9+ 가 필요하며,
표준 라이브러리 외 의존성은 없습니다.

```bash
git clone https://github.com/menonng/mineworldgen
cd mineworldgen

# 1. 프리셋을 고르거나 pack/config.json 을 직접 수정합니다
cp presets/earthlike.json pack/config.json

# 2. 데이터팩 파일을 생성합니다
python3 tools/apply_config.py

# 3. pack/ 폴더를 월드의 datapacks/ 안에 넣습니다
#    (또는 zip 으로 압축해서 넣어도 됩니다)
cp -r pack "<.minecraft>/saves/<world>/datapacks/mineworldgen"
```

> ⚠️ 지형은 월드를 **처음 만들 때** 결정됩니다. 설정을 바꾸면 **새 월드**를
> 만들어야 하며, 이미 생성된 청크는 바뀌지 않습니다.
> Terrain is baked when a chunk is first generated — change the config, make a
> new world.

`config.json` 에서는 `//` 와 `/* */` 주석을 쓸 수 있습니다.
`apply_config.py` 는 잘못된 값을 발견하면 이유를 알려주고 파일을 쓰지 않습니다.

```
$ python3 tools/apply_config.py
config.json has problems:
  - the deepest ocean floor (y=-29) is below world.terrain_min_y (-12);
    raise terrain_min_y or reduce the ocean depths
```

---

## 바닐라 폴백 / The vanilla fallback

`config.json` 의 최상단에 `"mode"` 가 있습니다.

```jsonc
"mode": "vanilla"   // 기본값 — 지형 파일을 아예 쓰지 않습니다
"mode": "custom"    // 아래 설정을 모두 적용합니다
```

`"vanilla"` 일 때 생성기는 **월드 생성 관련 파일을 단 하나도 출력하지 않습니다.**
`data/` 안에는 아무 데이터도 참조하지 않는 빈 density function 하나만 남습니다.
바닐라를 "흉내내는" 것이 아니라 **바닐라 파일을 아예 덮어쓰지 않기 때문에**,
지형이 100% 동일한 것이 수학적으로 보장됩니다.

At `"vanilla"` the generator writes **no world generation file at all** — not a
re-derivation of vanilla's density functions, just nothing. Identity is
therefore structural, not something that has to be verified.

프리셋 파일에는 모두 `"mode": "custom"` 이 들어 있습니다.

---

## 추천 프리셋 / Recommended presets

각 코드 블록 오른쪽 위의 복사 버튼을 눌러 `pack/config.json` 에 그대로
붙여넣으세요. Click the copy button and paste straight into `pack/config.json`.

<table>
<tr>
<td align="center"><img src="docs/img/earthlike.png" width="230"><br><sub><b>earthlike</b></sub></td>
<td align="center"><img src="docs/img/archipelago.png" width="230"><br><sub><b>archipelago</b></sub></td>
<td align="center"><img src="docs/img/pangaea.png" width="230"><br><sub><b>pangaea</b></sub></td>
</tr>
<tr>
<td align="center"><img src="docs/img/highlands.png" width="230"><br><sub><b>highlands</b></sub></td>
<td align="center"><img src="docs/img/waterworld.png" width="230"><br><sub><b>waterworld</b></sub></td>
<td align="center"><sub>모든 미리보기는 57 344 × 57 344 블록,<br>seed 1234, 시뮬레이터 렌더링</sub></td>
</tr>
</table>

---

<details>
<summary><b>🌍 earthlike</b> — 지구형. 적당한 크기의 대륙과 넓은 바다, 가장 무난한 기본 설정.<br>
<sub>Balanced continents and oceans. Start here if you are not sure.</sub></summary>

동서로 살짝 길쭉한 대륙 여러 개, 육지 약 29%, 대륙 사이에 열도와 화산섬.
스폰은 중앙 대륙 위에 고정됩니다.

```json
{
  "format": 1,
  "mode": "custom",
  "world": { "sea_level": 63, "build_min_y": -64, "build_height": 384,
             "terrain_max_y": 300, "terrain_min_y": -44, "vertical_scale": 1.0 },
  "center": { "type": "continent", "radius": 3000, "strength": 1.0 },
  "continents": {
    "land_ratio": 0.29, "width": 9000, "height": 7000,
    "width_variation_percent": 35, "height_variation_percent": 35,
    "erosion_scale": 1.0, "ridge_scale": 1.0, "flat_terrain_skew": 0.10,
    "mountain_ranges": 1.0, "plateaus": 1.0, "tepui": 0.6, "rolling_hills": true
  },
  "rivers": { "enabled": true, "width": 1.1, "depth_blocks": 11 },
  "inland_seas": { "enabled": true, "frequency": 0.35, "size": 3500, "depth_blocks": 28 },
  "fjords": { "enabled": true, "frequency": 0.5, "width": 1.0, "depth_blocks": 26 },
  "islands": { "enabled": true, "size": 800, "frequency": 1.0, "clustering": 0.55,
               "arc_strength": 0.7, "noise_offset": 0.05,
               "atoll_chance": 0.15, "volcanic_chance": 0.18, "cliff_chance": 0.20 },
  "oceans": { "ocean_depth_blocks": 30, "deep_ocean_depth_blocks": 62,
              "seafloor_relief": 1.0, "trenches": true, "trench_depth_blocks": 36 },
  "coast": { "cliffs": 0.6, "sea_stacks": 0.5, "columnar_jointing": 0.5 },
  "biomes": { "scale_with_continents": true, "temperature_scale": 1.0, "temperature_offset": 0.0,
              "temperature_multiplier": 1.0, "vegetation_scale": 1.0, "vegetation_offset": 0.0,
              "vegetation_multiplier": 1.0 },
  "caves": { "scale_with_continents": true, "size_multiplier": 1.0, "carvers_enabled": true },
  "structures": { "scale_with_continents": true, "spacing_multiplier": 1.0 },
  "spawn": { "force_land_spawn": true }
}
```
</details>

<details>
<summary><b>🏝️ archipelago</b> — 열도 세계. 배를 타고 섬을 옮겨 다니는 플레이용.<br>
<sub>Deep ocean scattered with tight island chains, atolls and volcanoes.</sub></summary>

육지 약 10%. 섬이 호를 그리며 뭉쳐서 생성되고, 환상산호도와 화산섬 비율이 높습니다.
스폰 지점은 열도 한가운데입니다. 구조물 간격을 좁혀 섬마다 뭔가 있도록 했습니다.

```json
{
  "format": 1,
  "mode": "custom",
  "world": { "sea_level": 63, "build_min_y": -64, "build_height": 384,
             "terrain_max_y": 288, "terrain_min_y": -48, "vertical_scale": 1.0 },
  "center": { "type": "archipelago", "radius": 3500, "strength": 1.0 },
  "continents": {
    "land_ratio": 0.10, "width": 2600, "height": 2600,
    "width_variation_percent": 45, "height_variation_percent": 45,
    "erosion_scale": 0.8, "ridge_scale": 0.9, "flat_terrain_skew": 0.10,
    "mountain_ranges": 0.9, "plateaus": 0.7, "tepui": 0.8, "rolling_hills": true
  },
  "rivers": { "enabled": true, "width": 0.8, "depth_blocks": 9 },
  "inland_seas": { "enabled": false, "frequency": 0.0, "size": 3000, "depth_blocks": 26 },
  "fjords": { "enabled": true, "frequency": 0.8, "width": 1.2, "depth_blocks": 28 },
  "islands": { "enabled": true, "size": 520, "frequency": 1.8, "clustering": 0.8,
               "arc_strength": 1.2, "noise_offset": 0.09,
               "atoll_chance": 0.26, "volcanic_chance": 0.26, "cliff_chance": 0.24 },
  "oceans": { "ocean_depth_blocks": 26, "deep_ocean_depth_blocks": 54,
              "seafloor_relief": 1.3, "trenches": true, "trench_depth_blocks": 40 },
  "coast": { "cliffs": 0.9, "sea_stacks": 1.0, "columnar_jointing": 0.9 },
  "biomes": { "scale_with_continents": true, "temperature_scale": 1.0, "temperature_offset": 0.25,
              "temperature_multiplier": 0.9, "vegetation_scale": 1.0, "vegetation_offset": 0.15,
              "vegetation_multiplier": 1.0 },
  "caves": { "scale_with_continents": true, "size_multiplier": 1.0, "carvers_enabled": true },
  "structures": { "scale_with_continents": false, "spacing_multiplier": 0.7 },
  "spawn": { "force_land_spawn": true }
}
```
</details>

<details>
<summary><b>🗺️ pangaea</b> — 초대륙. 걸어서 며칠 걸리는 하나의 거대한 땅덩어리.<br>
<sub>One enormous supercontinent with big inland seas and long rivers.</sub></summary>

가로 42 000 × 세로 26 000 블록 규모의 대륙, 육지 약 55%.
내해가 크게 생기고 강이 굵어집니다. 대륙이 커진 만큼 기후대·동굴·구조물 간격도
자동으로 함께 커집니다 (`scale_with_continents`).

```json
{
  "format": 1,
  "mode": "custom",
  "world": { "sea_level": 63, "build_min_y": -64, "build_height": 384,
             "terrain_max_y": 306, "terrain_min_y": -40, "vertical_scale": 1.15 },
  "center": { "type": "continent", "radius": 12000, "strength": 1.0 },
  "continents": {
    "land_ratio": 0.55, "width": 42000, "height": 26000,
    "width_variation_percent": 20, "height_variation_percent": 20,
    "erosion_scale": 1.4, "ridge_scale": 1.5, "flat_terrain_skew": 0.14,
    "mountain_ranges": 1.25, "plateaus": 1.2, "tepui": 0.8, "rolling_hills": true
  },
  "rivers": { "enabled": true, "width": 1.6, "depth_blocks": 14 },
  "inland_seas": { "enabled": true, "frequency": 0.6, "size": 9000, "depth_blocks": 34 },
  "fjords": { "enabled": true, "frequency": 0.4, "width": 1.0, "depth_blocks": 26 },
  "islands": { "enabled": true, "size": 1400, "frequency": 0.6, "clustering": 0.3,
               "arc_strength": 0.3, "noise_offset": 0.03,
               "atoll_chance": 0.10, "volcanic_chance": 0.20, "cliff_chance": 0.20 },
  "oceans": { "ocean_depth_blocks": 32, "deep_ocean_depth_blocks": 66,
              "seafloor_relief": 0.9, "trenches": true, "trench_depth_blocks": 30 },
  "coast": { "cliffs": 0.5, "sea_stacks": 0.35, "columnar_jointing": 0.4 },
  "biomes": { "scale_with_continents": true, "temperature_scale": 1.0, "temperature_offset": 0.0,
              "temperature_multiplier": 1.15, "vegetation_scale": 1.0, "vegetation_offset": -0.1,
              "vegetation_multiplier": 1.0 },
  "caves": { "scale_with_continents": true, "size_multiplier": 1.0, "carvers_enabled": true },
  "structures": { "scale_with_continents": true, "spacing_multiplier": 1.0 },
  "spawn": { "force_land_spawn": true }
}
```
</details>

<details>
<summary><b>⛰️ highlands</b> — 고산 세계. 월드 높이를 512로 늘려 y430까지 솟는 산맥.<br>
<sub>Build height raised to 512, terrain reaching y 430, deep fjords everywhere.</sub></summary>

`build_height` 를 512로 올리고 `vertical_scale` 1.6을 적용합니다. 절벽 섬과
화산섬 비율이 높고, 피오르드가 깊게 파고듭니다. 테푸이와 고원도 강하게 나옵니다.
월드 높이가 바닐라와 달라지므로 `dimension_type` 도 함께 덮어씁니다.

```json
{
  "format": 1,
  "mode": "custom",
  "world": { "sea_level": 63, "build_min_y": -64, "build_height": 512,
             "terrain_max_y": 430, "terrain_min_y": -50, "vertical_scale": 1.6 },
  "center": { "type": "island", "radius": 2200, "strength": 1.0 },
  "continents": {
    "land_ratio": 0.34, "width": 7000, "height": 7000,
    "width_variation_percent": 30, "height_variation_percent": 30,
    "erosion_scale": 1.2, "ridge_scale": 1.1, "flat_terrain_skew": 0.06,
    "mountain_ranges": 1.7, "plateaus": 1.5, "tepui": 1.4, "rolling_hills": true
  },
  "rivers": { "enabled": true, "width": 1.0, "depth_blocks": 13 },
  "inland_seas": { "enabled": true, "frequency": 0.25, "size": 2800, "depth_blocks": 30 },
  "fjords": { "enabled": true, "frequency": 0.9, "width": 1.3, "depth_blocks": 40 },
  "islands": { "enabled": true, "size": 650, "frequency": 1.1, "clustering": 0.6,
               "arc_strength": 0.8, "noise_offset": 0.05,
               "atoll_chance": 0.10, "volcanic_chance": 0.32, "cliff_chance": 0.38 },
  "oceans": { "ocean_depth_blocks": 34, "deep_ocean_depth_blocks": 74,
              "seafloor_relief": 1.4, "trenches": true, "trench_depth_blocks": 36 },
  "coast": { "cliffs": 1.3, "sea_stacks": 1.2, "columnar_jointing": 1.2 },
  "biomes": { "scale_with_continents": true, "temperature_scale": 1.0, "temperature_offset": -0.15,
              "temperature_multiplier": 1.1, "vegetation_scale": 1.0, "vegetation_offset": 0.0,
              "vegetation_multiplier": 1.0 },
  "caves": { "scale_with_continents": true, "size_multiplier": 1.3, "carvers_enabled": true },
  "structures": { "scale_with_continents": true, "spacing_multiplier": 1.0 },
  "spawn": { "force_land_spawn": true }
}
```
</details>

<details>
<summary><b>🌊 waterworld</b> — 수몰 세계. 작은 섬만 남은 따뜻한 바다.<br>
<sub>Almost nothing but warm ocean, small islands and coral atolls.</sub></summary>

작은 섬 위주, 환상산호도 비율 34%. 기후를 따뜻하고 습하게 밀어 산호초와
정글 섬이 잘 나옵니다. 구조물 간격을 크게 좁혀 난파선과 해저 유적을 늘렸습니다.

```json
{
  "format": 1,
  "mode": "custom",
  "world": { "sea_level": 63, "build_min_y": -64, "build_height": 384,
             "terrain_max_y": 260, "terrain_min_y": -52, "vertical_scale": 0.9 },
  "center": { "type": "island", "radius": 1400, "strength": 1.0 },
  "continents": {
    "land_ratio": 0.09, "width": 1800, "height": 1800,
    "width_variation_percent": 50, "height_variation_percent": 50,
    "erosion_scale": 0.7, "ridge_scale": 0.8, "flat_terrain_skew": 0.10,
    "mountain_ranges": 0.7, "plateaus": 0.6, "tepui": 0.5, "rolling_hills": true
  },
  "rivers": { "enabled": true, "width": 0.7, "depth_blocks": 8 },
  "inland_seas": { "enabled": false, "frequency": 0.0, "size": 3000, "depth_blocks": 26 },
  "fjords": { "enabled": true, "frequency": 0.7, "width": 1.1, "depth_blocks": 22 },
  "islands": { "enabled": true, "size": 380, "frequency": 1.1, "clustering": 0.35,
               "arc_strength": 1.5, "noise_offset": 0.11,
               "atoll_chance": 0.34, "volcanic_chance": 0.22, "cliff_chance": 0.16 },
  "oceans": { "ocean_depth_blocks": 24, "deep_ocean_depth_blocks": 50,
              "seafloor_relief": 1.5, "trenches": true, "trench_depth_blocks": 44 },
  "coast": { "cliffs": 0.7, "sea_stacks": 1.1, "columnar_jointing": 0.8 },
  "biomes": { "scale_with_continents": true, "temperature_scale": 1.2, "temperature_offset": 0.30,
              "temperature_multiplier": 0.85, "vegetation_scale": 1.2, "vegetation_offset": 0.20,
              "vegetation_multiplier": 0.9 },
  "caves": { "scale_with_continents": true, "size_multiplier": 1.0, "carvers_enabled": true },
  "structures": { "scale_with_continents": false, "spacing_multiplier": 0.55 },
  "spawn": { "force_land_spawn": true }
}
```
</details>

<details>
<summary><b>🧪 vanilla</b> — 아무것도 바꾸지 않는 기본값 (폴백 확인용).</summary>

```json
{
  "format": 1,
  "mode": "vanilla"
}
```

이 설정으로 `apply_config.py` 를 돌리면 `data/` 에 지형 관련 파일이 하나도
생기지 않습니다. 즉 바닐라 그대로입니다.
</details>

---

## 설정 항목 전체 / Full config reference

### `world`

| 항목 | 기본값 | 범위 | 설명 |
|---|---|---|---|
| `sea_level` | 63 | −2032 … 2032 | 해수면 높이 |
| `build_min_y` | −64 | 16의 배수 | 월드 최소 Y좌표 |
| `build_height` | 384 | 16의 배수, ≤ 4064 | 월드 전체 높이 (최대 Y = min + height) |
| `terrain_max_y` | 312 | | 지표면이 도달할 수 있는 최고 높이 |
| `terrain_min_y` | −40 | | 해저가 내려갈 수 있는 최저 높이 |
| `vertical_scale` | 1.0 | 0.1 … 4.0 | 해수면 **위** 지형 전체의 높이 배율 |

`build_min_y` / `build_height` 가 바닐라(−64 / 384)와 다르면 `dimension_type`
과 `noise_settings` 도 함께 출력됩니다.

### `center` — 월드 중앙 (0, 0) 에 무엇을 둘 것인가

| 값 | 결과 |
|---|---|
| `"default"` | 기존 생성 알고리즘에 맡김 (바닐라 동작) |
| `"continent"` | 거대한 대륙 |
| `"island"` | 큰 섬 하나 |
| `"archipelago"` | 여러 섬의 열도 |
| `"ocean"` | 바다 |

`radius` (블록, 기본 2500) 만큼의 영역에 적용되고, `strength` (0 … 2) 로 세기를
조절합니다. 경계는 부드럽게 흐려집니다.

### `continents`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `land_ratio` | 0.32 | 해수면 위 육지 비율 (0.02 … 0.95) |
| `ocean_offset` | `null` | 고급: `land_ratio` 대신 원시 값을 직접 지정 |
| `width` | 6000 | 대륙 하나의 평균 **가로**(최서단↔최동단) 길이, 블록 |
| `height` | 6000 | 대륙 하나의 평균 **세로**(최북단↔최남단) 길이, 블록 |
| `width_variation_percent` | 30 | 가로 길이 변동계수 (%) — 해안선이 기본값에서 얼마나 벗어나는지 |
| `height_variation_percent` | 30 | 세로 길이 변동계수 (%) |
| `erosion_scale` | 1.0 | 침식 노이즈 수평 배율 — 크면 산계·평원이 넓어짐 |
| `ridge_scale` | 1.0 | 능선 노이즈 수평 배율 — 크면 강이 드물고 굵어짐 |
| `flat_terrain_skew` | 0.10 | 고원 지형과 평지 지형의 경계 |
| `mountain_ranges` | 1.0 | 거대 산맥 강도 (0 = 없음) |
| `plateaus` | 1.0 | 고원 강도 |
| `tepui` | 0.6 | 테푸이 강도 (열대 지역에만) |
| `rolling_hills` | `true` | 완만한 구릉 지형 |

**`width` : `height` 비율은 1 : 1.81 을 넘을 수 없습니다.**
이유는 [한계와 주의사항](#한계와-주의사항--limits-and-caveats) 참고.

### `rivers` / `inland_seas` / `fjords`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `rivers.enabled` | `true` | 대륙을 가로지르는 강 |
| `rivers.width` | 1.0 | 강 굵기 (0.1 … 4.0) |
| `rivers.depth_blocks` | 10 | 강바닥이 해수면 아래로 파이는 깊이 |
| `inland_seas.enabled` | `true` | 대륙 내부의 내해 |
| `inland_seas.frequency` | 0.35 | 내륙에서 내해가 차지하는 비율 (0 … 1) |
| `inland_seas.size` | 3000 | 내해 평균 지름, 블록 |
| `inland_seas.depth_blocks` | 26 | 내해 깊이 |
| `fjords.enabled` | `true` | 암석 해안을 파고드는 좁고 깊은 만 |
| `fjords.frequency` | 0.6 | 피오르드가 생기는 해안의 비율 |
| `fjords.width` | 1.0 | 피오르드 폭 |
| `fjords.depth_blocks` | 24 | 피오르드 깊이 |

강과 피오르드는 모두 바닐라의 weirdness(능선) 골짜기를 따라갑니다. 그래서 강에는
바닐라 River 바이옴이, 침수된 하곡에는 해양 바이옴이 정확히 배치됩니다.

### `islands`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `enabled` | `true` | |
| `size` | 700 | 섬 하나의 평균 지름, 블록 |
| `frequency` | 1.0 | 심해에 생기는 섬의 양 (0 … 3) |
| `clustering` | 0.5 | **섬들이 뭉치는 밀도.** 0 = 고르게 흩어짐, 1 = 빽빽하게 뭉침 |
| `arc_strength` | 0.6 | 섬들이 호를 그리며 늘어서는 정도 (호상열도) |
| `noise_offset` | 0.05 | 섬 전체의 높낮이. 낮출수록 버섯 섬이 늘어남 |
| `atoll_chance` | 0.18 | 환상산호도 비율 |
| `volcanic_chance` | 0.20 | 화산섬 비율 |
| `cliff_chance` | 0.22 | 절벽·산악 섬 비율 |

세 비율의 합이 0.95를 넘으면 자동으로 축소되며, 나머지는 일반 섬입니다.

### `oceans` / `coast`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `oceans.ocean_depth_blocks` | 28 | 일반 바다 깊이 (해수면 기준 블록) |
| `oceans.deep_ocean_depth_blocks` | 58 | 심해 깊이 |
| `oceans.seafloor_relief` | 1.0 | 해저 기복 |
| `oceans.trenches` | `true` | 심해 해구 |
| `oceans.trench_depth_blocks` | 34 | 해구가 추가로 파이는 깊이 |
| `coast.cliffs` | 0.6 | 깎아지른 해안 절벽 (0 … 2) |
| `coast.sea_stacks` | 0.5 | 시스택 — 앞바다에 홀로 선 바위 기둥 |
| `coast.columnar_jointing` | 0.5 | 주상절리 — 평평한 윗면의 계단형 기둥 |

`deep_ocean_depth_blocks + trench_depth_blocks` 가 `terrain_min_y` 를 넘어서면
`apply_config.py` 가 거부합니다.

### `biomes`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `scale_with_continents` | `true` | **기후 스케일 동기화.** 대륙이 커진 배율만큼 온도·습도 노이즈도 커짐 |
| `temperature_scale` | 1.0 | 온도 기후대 크기 배율 (동기화 위에 추가로 곱해짐) |
| `temperature_offset` | 0.0 | 전체를 따뜻하게(+) / 춥게(−) (−1 … 1) |
| `temperature_multiplier` | 1.0 | 극단적인 기후 강조 |
| `vegetation_scale` / `_offset` / `_multiplier` | | 습도(식생) 쪽 동일 |

동기화가 없으면 42 000 블록짜리 대륙 안에 바이옴이 바둑판처럼 촘촘히 깔립니다.
`pangaea` 프리셋에서는 기후 노이즈가 자동으로 **약 21배** 커집니다.

### `caves` / `structures` / `spawn`

| 항목 | 기본값 | 설명 |
|---|---|---|
| `caves.scale_with_continents` | `true` | 지형이 커지면 동굴도 비례해 커짐 (`size_factor^0.35`, 최대 2.5배) |
| `caves.size_multiplier` | 1.0 | 동굴 크기 직접 배율 (0.25 … 4.0) |
| `caves.carvers_enabled` | `true` | 구형 동굴/협곡 카버 |
| `structures.scale_with_continents` | `true` | 구조물 생성 간격이 지형 크기에 비례 (`size_factor^0.5`, 최대 6배) |
| `structures.spacing_multiplier` | 1.0 | 구조물 간격 직접 배율 (0.25 … 8.0) |
| `spawn.force_land_spawn` | `true` | 스폰 지점을 무조건 육지로 |

동굴 크기는 바닐라 동굴 노이즈의 옥타브를 옮겨서 조절합니다. 옥타브 사이의 값은
인접한 두 옥타브의 진폭 배열을 섞어 연속적으로 보간하므로, 1.3배 같은 값도
정확히 적용됩니다.

구조물 간격은 **바닐라 26.2의 실제 structure_set 파일**을 읽어 `spacing` 과
`separation` 을 비율대로 바꿔 다시 씁니다 (`villages`, `ocean_monuments`,
`strongholds` 등 오버월드 17종). 배율이 1.0이면 아무 파일도 쓰지 않습니다.

---

## 생성되는 지형 / What the terrain system produces

바닐라 바이옴만 사용하면서 다음 지형이 자연스럽게 나옵니다.

| 지형 | 구현 방식 |
|---|---|
| **거대 산맥** | 도메인 워핑한 능선 노이즈(`1 − \|n\|`)를 침식값에서 빼서, 침식이 낮은 **선형** 띠를 만듭니다. 산이 점점이 흩어지지 않고 실제 산맥처럼 이어집니다. |
| **고원** | 평평한 단(段)과 가파른 벽이 번갈아 나오는 계단형 스플라인 + 높은 `factor` |
| **테푸이** | 고원과 같은 원리를 극단으로: 0.04 구간에서 거의 수직으로 0.86까지 올라갑니다. 식생값이 높은 열대 지역에만 배치 |
| **깎아지른 절벽** | 해안 구간에서 침식이 낮을 때 오프셋을 크게 올리고 `factor` 를 5.6 → 9.5 까지 높여 수직에 가깝게 만듭니다 |
| **시스택** | 서로 독립적인 두 노이즈의 능선을 `min` 으로 교차시키면 **선이 아니라 점**이 남습니다. 그 점들만 해안 마스크 안에서 솟아오릅니다 |
| **주상절리** | 같은 교차 기법을 8블록 규모로 쓰되, 스플라인을 3블록씩 평평한 계단으로 만들어 윗면이 평평한 기둥 무리를 만듭니다 |
| **호상열도** | 저주파 노이즈의 영점 집합(`\|n\| ≈ 0`)은 월드를 가로지르는 **곡선**입니다. 그 곡선 위에서만 섬 생성 확률을 올리면 자연스럽게 활 모양 열도가 됩니다 |
| **환상산호도** | 섬 높이값을 링 모양 스플라인에 통과시켜, 중간 높이는 물 위로 올리고 중심은 다시 물 아래로 내립니다. 온도도 +0.35 밀어 따뜻한 바다에 배치 |
| **화산섬** | 정점 직전까지 급격히 솟다가 맨 꼭대기에서 다시 내려오는 스플라인 → 분화구 |
| **산악 섬** | 섬 침식값을 −0.95까지 강제해 바닐라가 peaks 계열 바이옴을 고르게 합니다 |
| **대륙 강** | weirdness 골짜기(PV ≈ −1)를 따라 오프셋을 내립니다. 바닐라 River 바이옴과 정확히 겹칩니다 |
| **피오르드** | 같은 골짜기를 해안 + 낮은 침식 + 별도 선택 노이즈로 걸러 훨씬 깊게 팝니다 |
| **내해** | 저주파 노이즈로 대륙 내부를 골라 오프셋을 내리고, 동시에 대륙성(continentalness)도 낮춰서 해안·바다 바이옴이 붙도록 합니다 |
| **해구** | 심해에서 능선 노이즈의 좁은 골을 따라 추가로 파냅니다 |

---

## 작동 원리 / How it works

### 바닐라 위에 얹는 패치

이 데이터팩은 바닐라를 흉내내지 않고 **바닐라 26.2 파일을 읽어서 고쳐 씁니다.**
`tools/vanilla/minecraft/` 에 바닐라 26.2 월드 생성 데이터가 그대로 들어 있고,
생성기는 그중 필요한 것만 바꿔 출력합니다.

덮어쓰는 파일은 이것뿐입니다.

```
data/minecraft/worldgen/density_function/overworld/
    continents.json   erosion.json   ridges.json
    offset.json       factor.json    jaggedness.json   depth.json
data/minecraft/worldgen/noise_settings/overworld.json   (기후 라우터·해수면·월드 높이·스폰 타겟만 수정)
data/minecraft/dimension_type/overworld.json            (월드 높이를 바꿀 때만)
data/minecraft/worldgen/noise/<cave noises>.json        (동굴 크기를 바꿀 때만)
data/minecraft/worldgen/structure_set/*.json            (구조물 간격을 바꿀 때만)
```

**바이옴 배치는 손대지 않습니다.** 바닐라의 multi-noise 바이옴 소스가 그대로
`continentalness / erosion / weirdness / temperature / humidity / depth` 를 읽기
때문에, 나올 수 있는 바이옴은 바닐라 바이옴뿐입니다. 표면 규칙(surface rule),
카버, 광맥, 구조물 정의도 전부 바닐라입니다 — 26.2에서 추가된 `sulfur_caves` 도
그대로 동작합니다.

### 밀도 함수 그래프

`mwg` 네임스페이스에 약 60개의 density function 과 30개의 노이즈가 생성됩니다.

```
mwg:parameter/continentalness ──blur(7 taps)──► mwg:noise/continent_raw
                                                        │
mwg:size_bias/{width,height} ──blur(9 taps)──► mwg:noise/size_bias
mwg:center/ring1..4 ──────────────────────────► mwg:center/bias
                                                        ▼
                                          mwg:noise/raw_continents
                                          ├─► mwg:selector/island  ─┐
                                          └─► mwg:selector/continent│
                                                                    │
mwg:island/{a,b,cluster,arc,type} ─► mwg:noise/raw_islands ─────────┤
                                                                    ▼
                                       mwg:noise/full_continents ──► minecraft:overworld/continents
mwg:mountain/{base,detail,warp} ─► mwg:mountain/ridges ─┐
mwg:parameter/erosion ──────────────────────────────────┴─► mwg:biome/erosion  ──► minecraft:overworld/erosion
mwg:parameter/ridge ───────────────► mwg:biome/ridges ─────────────────────────► minecraft:overworld/ridges
                                     mwg:biome/ridges_folded (= 1 − 3·||r| − ⅔|)
                                                │
        ┌───────────────────────────────────────┴──────────────────────────┐
        ▼                                                                  ▼
mwg:water/{river,fjord,inland_sea} ─► mwg:water/carve        mwg:terrain/offset_{continents,islands}
mwg:terrain/{ocean_relief,coast_features} ───────────────────┴─► minecraft:overworld/offset
                                                              ─► minecraft:overworld/factor
                                                              ─► minecraft:overworld/jaggedness
```

설정값은 전부 `data/mwg/worldgen/density_function/config/*.json` 안의
constant density function 으로 들어갑니다. 스크립트 없이 이 파일들의 숫자만
직접 고쳐도 되고, Stardust Labs 계열 인게임 설정 모드가 접근할 수 있는 형태이기도
합니다.

```json
{ "type": "minecraft:constant", "argument": -1.0342 }
```

### 좌표를 읽을 수 없는 문제

Minecraft 의 density function 에는 월드 x/z 좌표를 읽는 수단이 **없습니다**
(`minecraft:y` 만 있습니다). 이 프로젝트에서 좌표가 필요한 두 기능은 다음
기법으로 우회했습니다.

* **중앙 지형 고정** — 같은 노이즈를 아주 살짝 다른 배율로 두 번 샘플링해
  차이를 봅니다. 원점에서는 두 샘플이 같은 지점이라 차이가 0이고, 멀어질수록
  선형으로 커집니다. 네 개의 옥타브로 평균을 내 부드럽게 만듭니다.
  (Stardust Labs 의 *Continents* 에서 배운 기법입니다.)
* **가로/세로 이방성** — `shifted_noise` 의 `shift_x` 에 **상수**를 넣으면 샘플
  지점이 그 축으로 평행이동합니다. 7개 탭을 한 축으로 늘어놓고 평균 내면 그
  축으로 지형이 늘어납니다.

두 기법 모두 실측으로 보정했습니다 → [`docs/CALIBRATION.md`](docs/CALIBRATION.md)

### 스폰 안전 보장

두 겹으로 막습니다.

1. `noise_settings` 의 `spawn_target` 을 `continentalness ≥ 0.03` 으로 좁혀,
   바닐라 스폰 탐색 자체가 내륙 기후만 후보로 삼게 합니다 (바닐라 기본값은
   −0.11 로, 해안과 얕은 바다까지 포함합니다).
2. 그래도 물에 떨어진 플레이어를 위해 `mwg:spawn/*` 함수가 첫 접속 시 발밑을
   확인하고, 물이면 400 → 36 000 블록까지 반경을 넓혀 가며 재배치한 뒤 육지를
   찾으면 그 자리를 월드 스폰으로 고정합니다. 최대 8회 시도 후 포기하며,
   이미 확인된 플레이어에게는 아무 명령도 실행하지 않습니다.

---

## 실측 결과 / Measured results

수치는 상상이 아니라 **시뮬레이션 측정값**입니다. `tools/mwgnoise` 는 마인크래프트의
Xoroshiro128++ 난수, `ImprovedNoise` / `PerlinNoise` / `NormalNoise`, 그리고
density function 평가기를 그대로 파이썬으로 구현한 것이고, 측정은 **실제로 출력되는
JSON 파일**을 읽어서 수행합니다.

```bash
python3 tools/measure.py --all-presets --markdown   # 아래 표를 그대로 재생성
python3 tools/validate.py                            # 모든 프리셋 무결성 검사
```

프리셋별 실측치 (seed 1234 / 9153 / 17072, 각 57 344 블록 정사각형 이상):

| preset | 육지 비율 요청/실측 | 대륙 요청 | 대륙 실측 | 섬 지름 요청/실측 | 바다 깊이 중앙/p95 | 지표 y 범위 |
|---|---|---|---|---|---|---|
| `archipelago` | 0.10 / **0.11** | 2600 × 2600 | **2758 × 2850** (n=156) | 520 / **831** | **26** / 55 | **−37 … 242** |
| `earthlike` | 0.29 / **0.25** | 9000 × 7000 | **10015 × 8867** (n=27) | 800 / **1436** | **29** / 64 | **−41 … 261** |
| `highlands` | 0.34 / **0.32** | 7000 × 7000 | **9253 × 9740** (n=35) | 650 / **1452** | **34** / 76 | **−50 … 430** |
| `pangaea` | 0.55 / **0.49** | 42000 × 26000 | **67360 × 41086** (n=151) | 1400 / — | **31** / 68 | **−38 … 306** |
| `waterworld` | 0.09 / **0.21** | 1800 × 1800 | **1721 × 1699** (n=718) | 380 / **662** | **20** / 52 | **−38 … 194** |

읽는 법:

* **육지 비율**은 ±0.04 안에서 맞습니다. `waterworld` 만 크게 벗어나는데, 그
  이유는 아래 [한계](#한계와-주의사항--limits-and-caveats) 의 "육지 비율 하한"
  항목에 적어 두었습니다.
* **대륙 크기**는 ±25% 정도로 맞습니다. 요청값은 *평균*이고, 실제 대륙 크기의
  자연 분산 자체가 커서(변동계수 60~90%) 개별 대륙은 훨씬 더 벗어납니다.
* **바다 깊이**는 설정값과 거의 정확히 일치합니다. 오프셋 1단위 = 128블록이라는
  항등식으로 변환하기 때문에 계산이 아니라 정의입니다.
* **지표 y 범위**는 `terrain_min_y` / `terrain_max_y` 안에 정확히 들어옵니다
  (`highlands`: 설정 −50 … 430, 실측 −50 … 430).
* `pangaea` 의 대륙 크기는 육지 비율 0.55 에서 대륙들이 서로 붙어버리기 때문에
  의미가 흐려집니다. 섬 지름도 마찬가지로 측정 불가입니다.

전체 원본 수치: [`docs/measurements.json`](docs/measurements.json)

---

## 한계와 주의사항 / Limits and caveats

### 가로 : 세로 비율은 1 : 1.81 까지

Density function 에는 월드 x/z 좌표를 읽는 수단이 없어서, 대륙 노이즈를
`(x/r, z)` 로 샘플링할 방법이 없습니다. 대신 한 축으로 7개 샘플을 평행이동시켜
평균 내는 방식으로 지형을 늘이는데, 이 방식은 **한 파장 정도에서 포화**합니다.
그 이상 넓게 평균 내면 위상이 반대인 이웃 융기가 상쇄되어 오히려 지형이 뭉개집니다.

실측 결과 최대 신장률은 **1.807** 이고, 그 이상 요청하면 `apply_config.py` 가
조용히 뭉개진 지형을 만드는 대신 오류로 거부합니다.

### 육지 비율 하한은 약 0.15

`land_ratio` 를 아무리 낮춰도 심해에 섬이 계속 생기기 때문에 총 육지 비율은
약 15% 아래로 내려가지 않습니다. 더 낮추려면 `islands.frequency` 도 함께
낮추세요. 반대로 `land_ratio` 표는 기본값인 변동계수 30% 기준으로 측정된
것이라, 변동계수를 0으로 두면 실제 육지 비율이 0.04 정도 낮게 나옵니다.

### 세밀한 지형은 4블록 격자에 걸립니다

`offset` 은 `flat_cache` 안에 있어 4×4 블록 컬럼마다 한 번만 계산되고, 지형
자체도 4블록 셀 사이를 보간합니다. 그래서 시스택과 주상절리 기둥은 4~8블록
굵기가 하한이며, 아주 가느다란 바늘 모양은 만들 수 없습니다. `coast.cliffs` 를
올리면 `factor` 가 함께 올라가 옆면이 더 수직에 가까워집니다.

### 동굴은 크기만 조절됩니다

동굴 종류별 on/off (Tectonic 의 cheese / noodle / spaghetti 개별 토글)는 바닐라
`overworld/caves/*` 를 통째로 다시 써야 해서 이번 버전에서는 넣지 않았습니다.
크기 배율과 카버 on/off 만 지원합니다.

### 26.2 전용

26.3 스냅샷에서 Mojang 이 density function 의 필드 이름을 바꿨습니다
(`argument` → `input`, `argument1`/`argument2` → `left`/`right`, `minecraft:lerp`
추가). 이 팩은 26.2 문법으로 출력하므로 26.3 이상에서는 다시 빌드해야 합니다.
`tools/vanilla/` 의 바닐라 데이터를 해당 버전으로 교체하고 `dsl.py` 의 필드 이름을
바꾸면 됩니다.

### 3D 노이즈는 시뮬레이션하지 않습니다

`minecraft:overworld/base_3d_noise` 는 바닐라 그대로 두었고, 측정 도구는 이를
계산하지 않습니다. 이 노이즈는 평균 0인 몇 블록 수준의 흔들림을 더하므로 넓은
영역의 통계에는 영향이 없지만, 개별 컬럼의 높이는 표에 적힌 값에서 몇 블록
차이 날 수 있습니다.

---

## 개발 도구 / Tooling

`tools/` 안의 스크립트는 전부 단독 실행 가능합니다. `apply_config.py` 만
표준 라이브러리로 동작하고, 나머지는 `numpy` / `scipy` / `pillow` 가 필요합니다.

| 스크립트 | 하는 일 |
|---|---|
| `apply_config.py` | `config.json` → 데이터팩 생성. **의존성 없음** |
| `validate.py` | 모든 프리셋을 빌드해 JSON 파싱, 참조 해결, 스플라인 단조성, 그래프 순환, 실제 평가 가능 여부를 검사 |
| `measure.py` | 생성된 팩을 시뮬레이션해 육지 비율·대륙 크기·바다 깊이 등을 측정 |
| `render.py` | 설정으로부터 지형 미리보기 PNG 생성 |
| `calibrate.py` | 보정 표(`mwgbuild/calibration.json`)를 실측으로 다시 만듦 |
| `mwgnoise/` | 마인크래프트 노이즈·density function 시뮬레이터 |
| `mwgbuild/` | 데이터팩 생성기 |
| `vanilla/` | 바닐라 26.2 월드 생성 데이터 (패치 기준) |

```bash
python3 tools/validate.py
# ok    vanilla-default
# ok    archipelago.json
# ok    earthlike.json
# ok    highlands.json
# ok    pangaea.json
# ok    waterworld.json
#
# all packs valid
```

---

## 크레딧 / Credits

설계는 다음 프로젝트들에서 배웠습니다.

* **[Tectonic](https://github.com/Apollounknowndev/tectonic)** (Apollo) — 설정
  항목의 구성, 상수 density function 으로 설정을 노출하는 방식, 대륙/섬 셀렉터
  구조, 노이즈 옥타브 튜닝
* **[Continents](https://modrinth.com/datapack/continents)** (Stardust Labs) —
  좌표를 읽을 수 없는 데이터팩에서 원점을 찾아내는 이중 배율 샘플링 기법,
  `dpconfig` 형태의 설정 노출
* **IslandGen** (MrRoaw) — `continents` 를 재작성해 섬 세계를 만드는 최소 구조
* **[ReTerraForged](https://github.com/racoonman2/ReTerraForged)** (racoonman2) —
  `continentScale` / `continentJitter` / `continentSizeVariance` / `SpawnType`
  같은 설정 축의 명명과 구성
* 바닐라 26.2 월드 생성 데이터는 [misode/mcmeta](https://github.com/misode/mcmeta)
  의 `26.2-data` 태그에서 가져왔습니다.

이 저장소의 코드와 지형 그래프는 새로 작성한 것이며, 위 데이터팩의 파일을 그대로
복사하지 않았습니다.
