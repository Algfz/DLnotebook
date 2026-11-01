@echo off
setlocal
cd /d "%~dp0"

rem ============================================================
rem  找运行时：优先 node，没有就用 python，两个都没有就打印自救说明
rem  说明：这个文件是 GBK 编码，别用 UTF-8 编辑器另存，否则中文会花。
rem ============================================================

set "RUNTIME="
where node >nul 2>nul
if not errorlevel 1 set "RUNTIME=node"
if defined RUNTIME goto :run_node

if exist "%ProgramFiles%\nodejs\node.exe" set "RUNTIME=%ProgramFiles%\nodejs\node.exe"
if defined RUNTIME goto :run_node
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "RUNTIME=%ProgramFiles(x86)%\nodejs\node.exe"
if defined RUNTIME goto :run_node
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "RUNTIME=%LocalAppData%\Programs\nodejs\node.exe"
if defined RUNTIME goto :run_node

set "PY="
where py >nul 2>nul
if not errorlevel 1 set "PY=py"
if defined PY goto :run_py
where python >nul 2>nul
if not errorlevel 1 set "PY=python"
if defined PY goto :run_py

goto :no_runtime

rem ------------------------------------------------------------
:run_node
echo.
echo   DLnotebook  -  跳舞的线复刻（本地运行）
echo   地址: http://localhost:8080
echo.
echo   运行时: %RUNTIME%
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
"%RUNTIME%" tools\dev-server.js --open
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:run_py
echo.
echo   DLnotebook  -  跳舞的线复刻（本地运行）
echo   地址: http://localhost:8080
echo.
echo   没找到 Node.js，改用 Python 起一个静态服务器（玩法一样，只是没有请求日志）。
echo   Keep this window open while playing. Press Ctrl+C to stop.
echo.
start "" http://localhost:8080
%PY% -m http.server 8080
echo.
echo   Server stopped.
pause
exit /b 0

rem ------------------------------------------------------------
:no_runtime
echo.
echo   ============================================================
echo    这台电脑没有装 Node.js，游戏跑不起来。
echo.
echo    解决办法（大约 1 分钟）：
echo      1. 打开   https://nodejs.org/zh-cn
echo      2. 下载标着 LTS 的那个版本，一路“下一步”装完（默认选项就行）
echo      3. 把本窗口关掉，重新双击「启动客户端.bat」
echo.
echo    注意：装完必须重新打开这个窗口，否则新装的 node 还没进 PATH。
echo   ============================================================
echo.
pause
exit /b 1
