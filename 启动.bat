@echo off
chcp 65001 >nul
title 课表规划 - 本地服务
cd /d "%~dp0"

echo ========================================
echo   课表规划 · 本地服务
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 20 以上版本
  echo        下载地址：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [1/3] 首次运行，正在安装依赖（约 1 分钟）...
  call npm install
  if errorlevel 1 (
    echo [错误] 依赖安装失败
    pause
    exit /b 1
  )
)

if not exist ".next\BUILD_ID" (
  echo [2/3] 正在构建...
  call npm run build
  if errorlevel 1 (
    echo [错误] 构建失败，请截图给开发者
    pause
    exit /b 1
  )
)

echo [3/3] 启动服务中，4 秒后自动打开浏览器...
echo.
echo   地址：http://localhost:3000
echo   关闭本窗口即停止服务
echo.
start "" cmd /c "timeout /t 4 >nul & start http://localhost:3000"
call npm start
pause