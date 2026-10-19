@echo off
rem Builds the MMD export plugin, the diagnostic probe and the test host (x64).
setlocal
set "VS=C:\Program Files (x86)\Microsoft Visual Studio"
set "PATH=%VS%\Installer;%PATH%"
call "%VS%\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 /LD src\plugin.cpp /Fobuild\ /Febuild\MMDEncoderPlugin.dll /link /DEF:src\plugin.def || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 /LD src\probe.cpp /Fobuild\ /Febuild\MMDEncoderProbe.dll /link /DEF:src\probe.def || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 tests\host.cpp /Fobuild\ /Febuild\probe-host.exe || exit /b 1
cl /nologo /std:c++17 /EHsc /O2 /W3 /utf-8 /DUNICODE /D_UNICODE tests\mmd-sim.cpp /Fobuild\ /Febuild\mmd-sim.exe || exit /b 1
echo Built build\MMDEncoderPlugin.dll, build\MMDEncoderProbe.dll and build\probe-host.exe
