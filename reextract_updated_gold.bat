@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title 11月金标准修正批次

pushd "%~dp0" || goto invalid_root
set "AA_ROOT=%CD%"
set "backup_dir="

where node.exe >nul 2>&1
if errorlevel 1 (
    echo 未找到 Node.js。请检查 PATH。
    goto failed
)
if not exist "tools\llm_run.mjs" goto missing_build
if not exist "packages\core\dist\index.js" goto missing_build
if not exist "packages\ingest\dist\index.js" goto missing_build
if not exist "packages\skills\dist\index.js" goto missing_build

for /f %%T in ('powershell.exe -NoProfile -NonInteractive -Command "Get-Date -Format yyyyMMdd-HHmmss-fff"') do set "backup_dir=build\reextract-backups\%%T"
if not defined backup_dir (
    echo 无法生成备份目录名称。
    goto failed
)
mkdir "%backup_dir%" || goto failed

echo 准备重新提取 26 篇研究。旧结果备份到 "%backup_dir%"。
echo.

rem 26 article IDs with changed or added values or explicit corrections in the November review workbooks.
call :reextract_year 2015 "2015-06" || goto failed
call :reextract_year 2016 "2016-01,2016-02,2016-03" || goto failed
call :reextract_year 2017 "2017-05,2017-12,2017-17" || goto failed
call :reextract_year 2018 "2018-02" || goto failed
call :reextract_year 2019 "2019-06,2019-07" || goto failed
call :reextract_year 2020 "2020-17" || goto failed
call :reextract_year 2021 "2021-01" || goto failed
call :reextract_year 2022 "2022-02" || goto failed
call :reextract_year 2023 "2023-02,2023-21,2023-27,2023-29" || goto failed
call :reextract_year 2024 "2024-01,2024-10,2024-12,2024-17,2024-29" || goto failed
call :reextract_year 2025 "2025-05,2025-06,2025-23,2025-24" || goto failed

echo.
echo 批次已跑完。各年的抽取摘要位于 build\extraction 下的 _run.json。
popd
pause
exit /b 0

:reextract_year
echo.
echo [%~1] %~2
mkdir "%backup_dir%\%~1" || exit /b 1
for %%S in (%~2) do (
    if exist "build\extraction\%~1\%%S.json" (
        copy /y "build\extraction\%~1\%%S.json" "%backup_dir%\%~1\%%S.json" >nul || exit /b 1
    )
)
if exist "build\extraction\%~1\_run.json" (
    copy /y "build\extraction\%~1\_run.json" "%backup_dir%\%~1\_run.json" >nul || exit /b 1
)
node.exe "tools\llm_run.mjs" --year %~1 --only "%~2" --fresh
exit /b %errorlevel%

:missing_build
echo 找不到抽取入口或已编译的提取包。请确认批处理位于项目根目录。
:failed
echo.
echo 批次中止。请检查上方错误和已生成的年度摘要。
if defined backup_dir echo 已备份的旧结果位于 "%backup_dir%"。
popd
pause
exit /b 1

:invalid_root
echo 无法进入批处理所在的项目目录。
pause
exit /b 1
