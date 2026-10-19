@echo off
chcp 65001 >nul
rem Installs the experimental MMDEncoder plugin for the current Windows user (no admin).
setlocal
set "DEST=%LOCALAPPDATA%\MMDEncoder\mmd-plugin\probe"
tasklist /FI "IMAGENAME eq MikuMikuDance.exe" /NH | find /I "MikuMikuDance.exe" >nul && (echo 请先关闭 MMD 再安装。 & pause & exit /b 1)
if not exist "%DEST%" mkdir "%DEST%"
copy /Y "%~dp0MMDEncoderProbe.dll" "%DEST%\MMDEncoderProbe.dll" >nul || (echo 复制失败。 & pause & exit /b 1)
"%SystemRoot%\System32\regsvr32.exe" /s "%DEST%\MMDEncoderProbe.dll" || (echo 注册失败。 & pause & exit /b 1)
echo 已安装：%DEST%\MMDEncoderProbe.dll
echo 打开 MMD，在“AVI 输出”的视频编码里选择“MMDEncoder (Probe)”。
echo 日志位置：%LOCALAPPDATA%\MMDEncoder\mmd-plugin\logs
pause
