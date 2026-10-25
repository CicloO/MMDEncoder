@echo off
rem Builds the MMD export plugin and the MMD simulator used by tests\e2e.mjs (x64).
setlocal
set "VS=C:\Program Files (x86)\Microsoft Visual Studio"
set "PATH=%VS%\Installer;%PATH%"
call "%VS%\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
node ..\scripts\plugin-messages.mjs || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 /LD src\plugin.cpp src\settings.cpp src\settings-layout.cpp src\messages.cpp src\processes.cpp src\json.cpp src\platform.cpp /Fobuild\ /Febuild\MMDEncoderPlugin.dll /link /DEF:src\plugin.def gdi32.lib || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 /DUNICODE /D_UNICODE tests\mmd-sim.cpp /Fobuild\ /Febuild\mmd-sim.exe || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 tests\message-check.cpp src\messages.cpp src\json.cpp src\platform.cpp /Fobuild\ /Febuild\message-check.exe /link ole32.lib shell32.lib || exit /b 1
echo Built build\MMDEncoderPlugin.dll and build\mmd-sim.exe
