@echo off
chcp 65001 >nul
setlocal
set "AA_ROOT=%~dp0"
set "AA_WORKFLOW_ROOT="
set "AA_CLIENT=%~dp0build\desktop-workflow\ArticleAgent-Workflow-0.2.5-portable.exe"
if not exist "%AA_CLIENT%" (
  echo 找不到四步工作流客户端，请先构建桌面版本。
  pause
  exit /b 1
)
start "" "%AA_CLIENT%"
endlocal
