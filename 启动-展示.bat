@echo off
chcp 65001 >nul 2>nul
title Novel Studio - DEMO
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0app-window.ps1" -Port 5368 -DataDir "data-demo" -Seed
