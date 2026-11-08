@echo off
setlocal
cd /d "%~dp0"
python -c "import pandas, pyarrow" >nul 2>&1
if errorlevel 1 (
  echo This simulator needs pandas and pyarrow to read the local bars.pkl data.
  echo Install them once with: python -m pip install -r requirements.txt
  pause
  exit /b 1
)
set SESSION_OPEN_BROWSER=1
python app.py
if errorlevel 1 (
  echo.
  echo Could not start the simulator. Check that Python 3.10 or newer is installed and port 8765 is available.
  pause
)
