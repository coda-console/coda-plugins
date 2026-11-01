# Grok Bot 品牌图形

仅用于标识会话所用的服务，不作为 Coda 自身标志。商标归各自权利人所有。

- `grok-bot.svg`：取自 [LobeHub Icons](https://github.com/lobehub/lobe-icons)（MIT，许可见 `LICENSE.lobehub`）
  `@lobehub/icons-static-svg` 1.101.0 的 `icons/grokbot.svg`，即 [Grok Bot](https://x.ai/bot) 的双眼圆脸机器人标志。
  只把 `currentColor` 换成黑色、去掉标题及网页布局样式，并把画布设为 256×256（iOS 按 96pt 光栅化 PDF 时只缩不放，页面太小会画成一个点），保留路径几何。
  眼睛是透明镂空；清单的 `template: true` 让它随文字颜色适配浅深色和选中态。
- `grok-bot.pdf`：四页矢量眨眼循环；睁眼 4.8 秒、半闭 0.06 秒、闭眼 0.08 秒、半睁 0.06 秒。
  每页的标准 PDF `/Dur` 声明显示秒数；Coda 在图标位置播放，原生菜单和“减少动态效果”使用第一页。
  `generate.py` 沿各眼睛的长轴压缩镂空路径，圆脸和睁眼时的路径不变。

提取日期：2026-11-01。SVG 是可审阅的源文件，清单的 `icon` 指向 PDF。在本目录重新生成 PDF（开发工具，不是构建或运行依赖；需要本机 Cairo）：

```sh
DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib uv run generate.py
```
