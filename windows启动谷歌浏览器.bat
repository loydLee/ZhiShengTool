@echo off
setlocal

set "CHROME_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME_EXE%" set "CHROME_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"

if not exist "%CHROME_EXE%" (
  echo Google Chrome not found.
  pause
  exit /b 1
)

set "PROFILE_DIR=%USERPROFILE%\chrome-automation-profile"
echo Starting Chrome remote debugging on port 9222...
echo Automation profile: %PROFILE_DIR%
"%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%PROFILE_DIR%"
endlocal
