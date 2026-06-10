# Run this in PowerShell (not in a sandbox) to push local code to GitHub.
# Repo: https://github.com/officeboy12242/WA-BOT

Set-Location $PSScriptRoot

Write-Host "Local latest commit:"
git log -1 --oneline

Write-Host "`nPushing to origin main (force-with-lease because histories diverged)..."
Write-Host "A GitHub login window may appear — sign in as officeboy12242`n"

git push --force-with-lease origin main

if ($LASTEXITCODE -eq 0) {
    Write-Host "`nDone! Check: https://github.com/officeboy12242/WA-BOT/tree/main"
} else {
    Write-Host "`nPush failed. Try:"
    Write-Host "  1. GitHub -> Settings -> Developer settings -> Personal access tokens"
    Write-Host "  2. Create token with 'repo' scope"
    Write-Host "  3. When prompted for password, paste the token (not your GitHub password)"
}
