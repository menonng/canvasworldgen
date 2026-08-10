# Translation keys

Every string the editor can display, including the terrain-feature vocabulary
and the compiler's clamping messages. English is the source of truth and the
fallback: a key missing from another table falls back to English, so a partial
translation is always safe to ship.

Minecraft's own names are **not** translated. Biome ids stay as registry ids
(`minecraft:plains`), and so do block ids — those are identifiers the data pack
writes and the player searches for in the game, not prose.

`{placeholders}` are filled at display time and must survive translation.

To add a locale, add a table to `web/src/i18n.ts` and extend `Locale`; then run
the command below to refresh this file.

```bash
cd web && npm run keys
```

| Key | English | 한국어 |
| --- | --- | --- |
| `action.analyse` | Analyse map | 지도 분석 |
| `action.exportPack` | Export world | 월드 내보내기 |
| `action.exportProject` | Export project | 프로젝트 저장 |
| `action.importProject` | Import project | 프로젝트 열기 |
| `action.redo` | Redo | 다시 실행 |
| `action.undo` | Undo | 실행 취소 |
| `adjust.buildLimits` | {path} moved from {from} to {to} to fit the build limits | {path} 을(를) {from} 에서 {to} 으로 옮겨 건축 한계에 맞췄습니다 |
| `adjust.centerType` | center.type "{value}" is not recognised, using "default" | center.type 값 "{value}" 을(를) 알 수 없어 "default" 를 사용합니다 |
| `adjust.continentHeight` | continents.height lowered from {from} to {to} (max ratio 1:{limit}) | continents.height 를 {from} 에서 {to} 으로 낮췄습니다 (최대 비율 1:{limit}) |
| `adjust.continentWidth` | continents.width lowered from {from} to {to} (max ratio 1:{limit}) | continents.width 를 {from} 에서 {to} 으로 낮췄습니다 (최대 비율 1:{limit}) |
| `adjust.islandChances` | island archetype chances summed above 0.95, scaled down to {atoll} / {volcanic} / {cliff} | 섬 유형 확률의 합이 0.95를 넘어 {atoll} / {volcanic} / {cliff} 로 줄였습니다 |
| `adjust.landRatio` | continents.land_ratio moved from {from} to {to} (reachable range with the current island settings) | continents.land_ratio 를 {from} 에서 {to} 으로 옮겼습니다 (현재 섬 설정에서 도달 가능한 범위) |
| `adjust.max` | {path} lowered from {value} to the maximum {bound} | {path} 을(를) {value} 에서 최댓값 {bound} 으로 내렸습니다 |
| `adjust.min` | {path} raised from {value} to the minimum {bound} | {path} 을(를) {value} 에서 최솟값 {bound} 으로 올렸습니다 |
| `adjust.mode` | mode "{value}" is not recognised, falling back to "vanilla" | mode 값 "{value}" 을(를) 알 수 없어 "vanilla" 로 되돌렸습니다 |
| `adjust.multiple16` | {path} rounded from {from} to {to} (must be a multiple of 16) | {path} 을(를) {from} 에서 {to} 으로 반올림했습니다 (16의 배수여야 합니다) |
| `adjust.notNumber` | {path} is not a number, using the default {fallback} | {path} 이(가) 숫자가 아니어서 기본값 {fallback} 을(를) 사용합니다 |
| `adjust.oceanDepthOrder` | oceans.ocean_depth_blocks was deeper than deep_ocean_depth_blocks, lowered to {to} | oceans.ocean_depth_blocks 가 deep_ocean_depth_blocks 보다 깊어서 {to} 로 낮췄습니다 |
| `adjust.oceanDepthScaled` | the configured ocean depth does not fit in the world, depths scaled to {deep} / {trench} blocks | 설정한 바다 깊이가 월드에 들어가지 않아 {deep} / {trench} 블록으로 줄였습니다 |
| `adjust.seaLevel` | world.sea_level moved from {from} to {to} to sit between the limits | world.sea_level 을 {from} 에서 {to} 으로 옮겨 상하한 사이에 맞췄습니다 |
| `adjust.terrainMinY` | world.terrain_min_y was at or above terrain_max_y, lowered to {to} | world.terrain_min_y 가 terrain_max_y 이상이어서 {to} 로 내렸습니다 |
| `adjust.terrainMinYForOcean` | world.terrain_min_y lowered from {from} to {to} to make room for the configured ocean depth | world.terrain_min_y 를 {from} 에서 {to} 으로 내려 설정한 바다 깊이를 담을 공간을 만들었습니다 |
| `analysis.apply` | Apply edits | 수정 적용 |
| `analysis.center` | Centre | 중심 |
| `analysis.clustering` | Clustering | 군집도 |
| `analysis.config` | Generator config (editable) | 생성기 설정 (직접 수정 가능) |
| `analysis.continentSize` | Continent size | 대륙 크기 |
| `analysis.islands` | Islands | 섬 |
| `analysis.landRatio` | Land ratio | 육지 비율 |
| `analysis.landmasses` | Landmasses | 육괴 개수 |
| `analysis.oceanDepth` | Ocean depth mean/max | 바다 깊이 평균/최대 |
| `analysis.reset` | Reset | 되돌리기 |
| `analysis.variation` | Size variation | 크기 편차 |
| `app.subtitle` | Design a world, compile it to a Minecraft 26.2 data pack | 월드를 그리고 마인크래프트 26.2 데이터팩으로 컴파일합니다 |
| `app.title` | MineWorldGen — World Designer | MineWorldGen — 월드 디자이너 |
| `biomeGroup.end` | End | 엔드 |
| `biomeGroup.nether` | Nether | 네더 |
| `biomeGroup.other` | Other | 기타 |
| `biomeGroup.overworld` | Overworld | 오버월드 |
| `brush.addFlag` | Add feature | 요소 추가 |
| `brush.amount` | Amount per stroke | 한 획당 변화량 |
| `brush.band` | Climate band | 기후대 |
| `brush.circle` | Circle | 원 |
| `brush.diamond` | Diamond | 마름모 |
| `brush.erase` | Erase | 지우기 |
| `brush.fill` | Fill area | 영역 채우기 |
| `brush.filter` | Filter biomes | 생물 군계 검색 |
| `brush.flag` | Feature | 지형 요소 |
| `brush.flatten` | Flatten | 평탄화 |
| `brush.flow` | Flow | 농도 |
| `brush.hint.biome` | All {count} biomes in the vanilla registry. Ids are shown exactly as the data pack writes them. | 바닐라 레지스트리의 생물 군계 {count}종 전부입니다. ID는 데이터팩이 쓰는 형태 그대로 표시합니다. |
| `brush.hint.fill` | One click replaces the whole connected area under the cursor. | 한 번 누르면 커서 아래로 이어진 영역 전체가 바뀝니다. |
| `brush.hint.flatten` | Levels everything to the height where the stroke began. | 획을 시작한 지점의 높이로 전부 맞춥니다. |
| `brush.hint.noise` | Adds a repeatable per-cell jitter, so the same spot always roughens the same way. | 칸마다 정해진 요철을 더합니다. 같은 자리는 항상 같은 모양으로 거칠어집니다. |
| `brush.hint.range` | Y {min} to {max}; sea level is {sea}. | Y {min} ~ {max}, 해수면은 {sea}. |
| `brush.hint.sharpen` | Pushes each cell away from its neighbours, deepening what is there. | 각 칸을 주변 평균에서 밀어내 기복을 강조합니다. |
| `brush.hint.smooth` | Averages each cell with its neighbours. | 각 칸을 주변 칸들과 평균냅니다. |
| `brush.hint.terrace` | Snaps heights to multiples of the step, for plateaus and tepuis. | 고도를 계단 높이의 배수로 맞춥니다. 고원과 테푸이에 적합합니다. |
| `brush.jitter` | Jitter | 요철 크기 |
| `brush.lower` | Lower | 낮추기 |
| `brush.lowerTo` | Lower to Y | Y까지 낮추기 |
| `brush.mode` | Mode | 방식 |
| `brush.noise` | Roughen | 거칠게 |
| `brush.paint` | Paint | 칠하기 |
| `brush.raise` | Raise | 높이기 |
| `brush.raiseTo` | Raise to Y | Y까지 높이기 |
| `brush.removeFlag` | Remove feature | 요소 제거 |
| `brush.set` | Set to Y | Y로 맞추기 |
| `brush.shape` | Shape | 모양 |
| `brush.sharpen` | Sharpen | 뚜렷하게 |
| `brush.size` | Size | 크기 |
| `brush.slope` | Slope strength | 경사 강도 |
| `brush.smooth` | Smooth | 부드럽게 |
| `brush.square` | Square | 정사각형 |
| `brush.step` | Step height | 계단 높이 |
| `brush.targetY` | Target Y | 목표 Y |
| `brush.terrace` | Terrace | 계단식 |
| `brush.value` | Value | 값 |
| `center.archipelago` | archipelago | 열도 |
| `center.continent` | continent | 대륙 |
| `center.default` | unforced | 지정 없음 |
| `center.island` | island | 섬 |
| `center.ocean` | ocean | 바다 |
| `climate.cold` | Cold | 한랭 |
| `climate.frozen` | Frozen | 혹한 |
| `climate.hot` | Hot | 고온 |
| `climate.temperate` | Temperate | 온화 |
| `climate.warm` | Warm | 온난 |
| `export.exact` | Exact — data pack + companion mod | 정밀 — 데이터팩 + 전용 모드 |
| `export.mode` | Export mode | 내보내기 방식 |
| `export.packName` | Pack name | 데이터팩 이름 |
| `export.procedural` | Procedural — vanilla data pack, no mod | 절차적 — 순수 데이터팩, 모드 불필요 |
| `export.vanilla` | Vanilla — identical to vanilla terrain | 바닐라 — 바닐라 지형과 완전히 동일 |
| `feature.atoll` | Atoll | 환상산호도 |
| `feature.columnar_jointing` | Columnar jointing | 주상절리 |
| `feature.coral_reef` | Coral reef | 산호초 |
| `feature.fjord` | Fjord | 피오르 |
| `feature.inland_sea` | Inland sea | 내해 |
| `feature.island_arc` | Island arc | 호상열도 |
| `feature.mountain_range` | Mountain range | 산맥 |
| `feature.plateau` | Plateau | 고원 |
| `feature.river` | River | 강 |
| `feature.sea_stack` | Sea stack | 시스택 |
| `feature.tepui` | Tepui | 테푸이 |
| `feature.volcano` | Volcano | 화산 |
| `hover.outside` | outside the design surface — procedural generation | 설계 영역 밖 — 절차적 생성 구간 |
| `layer.biome` | Biome | 생물 군계 |
| `layer.elevation` | Elevation | 고도 |
| `layer.feature` | Terrain feature | 지형 요소 |
| `layer.land` | Land / Ocean | 육지 / 바다 |
| `layer.temperature` | Temperature | 기온 |
| `layer.visible` | Visible | 표시 |
| `map.contourInterval` | Contour interval (blocks) | 등고선 간격 (블록) |
| `map.contours` | Contours | 등고선 |
| `map.grid` | Grid | 격자 |
| `map.height` | Height (blocks) | 세로 (블록) |
| `map.navHint` | Left-drag paints · right or middle-drag pans · wheel zooms · [ ] resize the brush | 왼쪽 드래그로 그리기 · 오른쪽·가운데 드래그로 이동 · 휠로 확대 · [ ] 로 브러시 크기 조절 |
| `map.new` | New map | 새 지도 |
| `map.resetView` | Reset view | 화면 맞춤 |
| `map.resolution` | Resolution (blocks per cell) | 해상도 (셀당 블록 수) |
| `map.seaLevel` | Sea level | 해수면 높이 |
| `map.seed` | Seed (0 = random) | 시드 (0 = 무작위) |
| `map.width` | Width (blocks) | 가로 (블록) |
| `note.allOcean` | the map is entirely ocean, so continent settings were left at their defaults | 지도가 전부 바다여서 대륙 설정은 기본값 그대로 두었습니다 |
| `note.clippedLandmasses` | every landmass touches the map edge, so sizes were taken from the clipped shapes | 모든 육괴가 지도 가장자리에 닿아 있어, 잘린 모양을 기준으로 크기를 쟀습니다 |
| `note.noContinents` | nothing drawn is large enough to count as a continent, so the continent scale was taken from the largest landmass | 대륙이라 할 만큼 큰 육지가 없어, 가장 큰 육괴 크기를 대륙 규모로 삼았습니다 |
| `panel.analysis` | Analysis | 분석 |
| `panel.brush` | Brush | 브러시 |
| `panel.export` | Export | 내보내기 |
| `panel.layers` | Layers | 레이어 |
| `panel.map` | Map | 지도 |
| `panel.presets` | Presets | 프리셋 |
| `panel.preview` | Preview | 미리보기 |
| `preset.hint` | A preset replaces the generator settings only. Your drawn map is left untouched, so you can start from a preset and refine it by hand. | 프리셋은 생성기 설정만 바꿉니다. 그려 둔 지도는 그대로 남으므로, 프리셋에서 출발해 직접 다듬을 수 있습니다. |
| `preset.load` | Load preset settings | 프리셋 설정 불러오기 |
| `preset.pick` | Preset | 프리셋 |
| `preview.caption` | Procedural Export reproduces the character and scale of your design, not its exact coastlines. Exact Export preserves position. | 절차적 내보내기는 설계의 성격과 규모를 재현할 뿐, 해안선을 그대로 옮기지는 않습니다. 정밀 내보내기는 위치까지 보존합니다. |
| `preview.neverAnalysed` | These are the current generator settings, not an analysis of your map — press refresh to match them to what you drew. | 지금 생성기 설정을 보여 줄 뿐, 그린 지도를 분석한 결과가 아닙니다 — 새로 고침을 눌러 지도에 맞추세요. |
| `preview.procedural` | Procedural result | 절차적 생성 결과 |
| `preview.refresh` | Refresh | 새로 고침 |
| `preview.refreshProcedural` | Re-analyse the map and rebuild the procedural preview | 지도를 다시 분석하고 절차적 미리보기를 새로 만듭니다 |
| `preview.refreshUser` | Redraw from the map as it is now | 현재 지도 상태로 다시 그립니다 |
| `preview.scale` | Both previews show the same window: {size} × {size} blocks | 두 미리보기가 보여 주는 범위: {size} × {size} 블록 |
| `preview.stale` | The map has changed since this was drawn — press refresh. | 그린 뒤로 지도가 바뀌었습니다 — 새로 고침을 누르세요. |
| `preview.user` | Your design | 내가 그린 지도 |
| `status.buildFailed` | Could not build the data pack | 데이터팩을 만들지 못했습니다 |
| `status.building` | Building the data pack... | 데이터팩을 만드는 중... |
| `status.configApplied` | Generator settings applied | 생성기 설정을 적용했습니다 |
| `status.configInvalid` | That is not valid JSON | 올바른 JSON이 아닙니다 |
| `status.configReset` | Generator settings restored | 생성기 설정을 되돌렸습니다 |
| `status.exactPending` | Exact Export needs the companion mod, which is not built yet | 정밀 내보내기는 전용 모드가 필요하며, 아직 만들어지지 않았습니다 |
| `status.filesWritten` | files written | 개 파일 생성 |
| `status.importFailed` | Could not import project | 프로젝트를 불러오지 못했습니다 |
| `status.imported` | Project imported | 프로젝트를 불러왔습니다 |
| `status.newMap` | New map created | 새 지도를 만들었습니다 |
| `status.presetFailed` | Could not load that preset | 프리셋을 불러오지 못했습니다 |
| `status.presetLoaded` | Preset loaded | 프리셋을 불러왔습니다 |
| `status.presetNone` | Pick a preset first | 먼저 프리셋을 고르세요 |
| `status.restored` | Restored the autosaved project | 자동 저장된 프로젝트를 복원했습니다 |
| `value.clear` | Clear | 없음 |
| `value.land` | Land | 육지 |
| `value.ocean` | Ocean | 바다 |
