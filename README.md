# 取帧

在本机解析视频播放页、媒体直链或 M3U8 链接，查看可用清晰度和格式，并通过浏览器保存文件。

## 网页版

打开 [GitHub Pages](https://phdsx.github.io/videodownloader/) 可下载支持跨域读取的 HTTPS 视频和音频直链，也可以通过 **试用示例** 下载仓库内的 MP4。解析视频播放页或 M3U8 时，请按下面的说明启动本地版，再点击页面中的 **打开本地版**。

## 启动

Windows 上安装 Python 3.11 或更新版本后，双击 `start.cmd`。首次运行会联网安装依赖，服务启动后会打开浏览器。也可以手动安装并运行。

```powershell
python -m pip install -r requirements.txt
python server.py --open
```

默认地址为 [http://127.0.0.1:8765](http://127.0.0.1:8765)。端口被占用时，可用 `python server.py --port 8766 --open`。通过运行窗口中的 Ctrl+C 停止服务。

## 使用

1. 粘贴单个视频的播放页或媒体直链，点击 **解析视频**。可用 **试用示例** 验证本机流程。
2. 在 **下载格式** 中选择需要的清晰度和容器，点击 **下载**。源站提供独立音轨时，可以切换到 **音频**。
3. 下载完成后，浏览器会保存文件。如浏览器拦截自动下载，可点击 **保存到电脑**。服务端临时文件保留 30 分钟，关闭服务时会清理。

解析和下载由 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 完成。将 [FFmpeg](https://ffmpeg.org/) 加入 PATH 可合并独立音视频轨道。部分网站需要将 Node.js 或 Deno 加入 PATH。要更新安装脚本使用的解析引擎，可运行 `.\.venv\Scripts\python.exe -m pip install -U -r requirements.txt`。

工具用于你有权下载的公开视频。登录限制、DRM、直播和平台变更会影响链接支持，实际格式以解析结果为准。
