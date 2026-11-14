@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0launch.mjs" %*
exit /b %errorlevel%
