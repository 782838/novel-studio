@echo off
chcp 65001 >nul 2>nul
title Novel Studio - WRITING
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app-window.ps1" -Port 5367 -DataDir "data-work"
