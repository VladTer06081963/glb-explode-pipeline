---
name: glb-exploded-view
description: Собирает детерминированное видео из 3D-модели (GLB) с разлётом по именованным частям, вырезкой (cutaway) и подписями органов/деталей. Используй, когда нужно разобрать объект на составляющие и показать это в ролике.
license: Apache-2.0
---

# GLB Exploded View

Метод: любой GLB с именованными mesh-нодами разбирается на части и собирается
обратно. Разлёт — **чистая функция времени**: `position(t) = f(t, part)`.
Никаких `Date.now()`, `Math.random()`, `performance.now()`, `mixer.update(dt)`.

## Цикл работы агента (обязательный порядок)

1. **Правь рецепт, а не код.** `recipes/<name>.json` — единственный источник правды:
   `variables` (model_url, explode_field, explode_amount, explode_start,
   explode_duration, camera_orbit, camera_fov, cutaway, labels).
2. **Собери кадры-превью** (дёшево, секунды):
   `node tools/capture.mjs --recipe recipes/ct-anatomy.json --at 0,1.5,3 --out out/preview --contact-sheet`
   → `out/preview/contact-sheet.png` + `out/preview/manifest.json` с sha256 каждого кадра.
3. **Посмотри на contact sheet** (это твой единственный «взгляд» на результат).
   Читай подписи кадров: `frame N · t=…s · sha256`.
4. **Исправь рецепт** и повтори п. 2. Не трогай `compositions/glb-exploded-view.html`,
   пока не исчерпал рецепт.
5. **Полный рендер** (только когда картинка верна):
   `node tools/capture.mjs --recipe recipes/ct-anatomy.json --out out/anatomy --contact-sheet --ffmpeg ffmpeg`
   → кадры + `film.mp4` + манифест.
6. **Проверь детерминизм** перед тем, как отдавать результат:
   `node tools/verify.mjs --recipe recipes/ct-anatomy.json --at 0,1,2,3`
   → оба прогона должны дать побайтово одинаковые sha256.

## Поля разлёта (`explode_field`)

| поле | когда применять | суть |
|---|---|---|
| `radial` | детали расходятся от центра тела | направление = normalize(center − centroid) |
| `hierarchical` | есть явные группы (позвоночник/рёбра, конечности) | направление = от ближайшего предка-части |
| `symmetric-fan` | симметричные группы (4 ноги, 2 лёгких) | веер по золотому углу вокруг оси группы |

## Кап-решения

- `explode_amount` задаёт **масштаб**: амплитуда = amount × max(len, 0.15 × maxRadius).
  Малое значение → разлёт не виден (частая ошибка).
- `explode_start` / `explode_duration` — окно в секундах. Дальше конца окна кадры
  одинаковы — это нормально, но для ролика с движением добавь `camera_orbit`.
- Камера в блоке фитится по **разлётной** позе: если разлёт увеличил объект
  вдвое, кадр всё равно влезет в кадр.
- Лейблы (`labels`) разводятся алгоритмом сортировки по Y; при 5+ подписях на
  близких частях они всё равно могут наложиться — сократи список.

## Ассеты

Каждый ассет фиксируется в `assets.manifest.json`: `sha256`, `bytes`, `source`,
`author`, `license`, `attribution`. Перед использованием проверь
`node tools/verify-assets.mjs` — расхождение sha256 означает, что ассет подменён.

## Инвентаризация каталогов

`node tools/glb-inventory.mjs --repo <hf-dataset> --sample 20` — доля файлов с
≥2 именованными mesh-нодами, средний размер, доля meshopt. Мебельные каталоги
(scanned-objects, abo) дают **1 mesh на файл** → разлёт по ним невозможен,
используй `cutaway`.
