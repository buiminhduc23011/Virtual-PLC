@echo off
setlocal
cd /d "%~dp0"
py -3 "%~dp0virtual_delta_modbus.py" --mode dvp --host 0.0.0.0 --port 502 %*
exit /b %errorlevel%
