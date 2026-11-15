@echo off
chcp 65001 >nul
echo.
echo  OneSun Code - установка
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo  [!] Не найден Node.js. Скачай и установи с https://nodejs.org ^(версия 18 или новее^),
  echo      потом запусти install.bat ещё раз.
  pause
  exit /b 1
)
cd /d "%~dp0"
call npm link
if errorlevel 1 (
  echo.
  echo  [!] Не получилось выполнить npm link. Попробуй запустить терминал от имени администратора.
  pause
  exit /b 1
)
echo.
echo  Готово! Открой новое окно терминала, перейди в папку своего проекта и введи:
echo.
echo      onesun
echo.
pause
