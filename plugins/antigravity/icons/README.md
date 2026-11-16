# Antigravity 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。Google Antigravity is a trademark of Google LLC，商标归各自权利人所有。

- `antigravity.svg`：取自 [Antigravity Press Assets](https://antigravity.google/press) 的 Icon – One Color
  （源文件 <https://antigravity.google/assets/image/brand/antigravity-icon__one-color.svg>）。只改了画布：
  `width`、`height` 由 180 改成 256 px（iOS 按 96 pt 光栅化 PDF 时只缩不放，页面太小会画成一个点），
  `viewBox` 由 `0 0 180 180` 裁成以标志为中心的正方形 `19.665 20 140 140`（标志的外框是 x 22.50–156.83、y 28.125–151.875）。
  路径与填色 `#202124` 一概不动，Google 的品牌规则不许改形、改色。
  单色，清单里 `template: true`，随文字颜色着色。用于 Antigravity。

提取日期：2026-11-16。SVG 是可审阅的源文件，PDF 是由 CairoSVG 转换的等比矢量资源，清单的 `icon` 指向 PDF。重新生成 PDF（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['antigravity']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```

macOS 上若找不到 libcairo，先 `brew install cairo`，再在命令前加 `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib`。
