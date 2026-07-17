# Copy this file as deploy.local.ps1 (which is ignored by Git) only if you want
# the publish button to force a Render deployment after pushing to GitHub.
# Get the hook from Render Dashboard -> Service -> Settings -> Deploy Hook.
$deployHook = ""
$siteUrl = "https://rethox.onrender.com"
