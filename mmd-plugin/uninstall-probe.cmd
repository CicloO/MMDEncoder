@echo off
chcp 65001 >nul
rem Removes the experimental plugin registration for the current user.
setlocal
set "DEST=%LOCALAPPDATA%\MMDEncoder\mmd-plugin\probe"
tasklist /FI "IMAGENAME eq MikuMikuDance.exe" /NH | find /I "MikuMikuDance.exe" >nul && (echo 请先关闭 MMD 再卸载。 & pause & exit /b 1)
if exist "%DEST%\MMDEncoderProbe.dll" "%SystemRoot%\System32\regsvr32.exe" /s /u "%DEST%\MMDEncoderProbe.dll"
if exist "%DEST%" rmdir /s /q "%DEST%"
echo 已卸载实验插件（日志保留在 %LOCALAPPDATA%\MMDEncoder\mmd-plugin\logs）。
pause
