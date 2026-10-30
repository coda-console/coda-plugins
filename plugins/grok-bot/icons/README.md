# Grok 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `grok.svg`：xAI 的公开站点拦截自动下载，取自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT）
  `@lobehub/icons-static-svg` 1.95.1 的 `icons/grok.svg`，即 Grok 的单色标志；只把 `currentColor` 换成黑色、去掉标题，并把画布从 24 放大到 256（iOS 按 96pt 光栅化 PDF 时只缩不放，页面太小会画成一个点），保留路径几何。用于 Grok。

提取日期：2026-09-19。SVG 是可审阅的源文件，PDF 是由 CairoSVG 转换的等比矢量资源，清单的 `icon` 指向 PDF。重新生成 PDF（开发工具，不是构建或运行依赖）：

```sh
uv run --with cairosvg python - <<'PY'
import cairosvg
for name in ['grok']:
    cairosvg.svg2pdf(url=f'{name}.svg', write_to=f'{name}.pdf')
PY
```
