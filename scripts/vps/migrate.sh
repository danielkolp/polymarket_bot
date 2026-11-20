# migrate: migration now happens automatically on the first deploy
# (scripts/vps/deploy-release.sh). This task just reports the layout.
ls -la "$BONK_ROOT" 2>/dev/null || echo "$BONK_ROOT not created yet - push a commit to deploy"
ls -la "$BONK_SHARED" 2>/dev/null
