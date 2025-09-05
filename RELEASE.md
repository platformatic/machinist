# Release Process

This document describes the release process for Machinist-3.

## Prerequisites

- Ensure you have write access to the repository
- Ensure all tests are passing on the main branch
- Ensure you have the necessary permissions to push Docker images to GitHub Container Registry

## Release Workflow

We use GitHub Actions for automated releases. The release workflow handles:

1. Version updates across all package.json files
2. Git tagging
3. Docker image building and publishing

## Steps to Create a Release

### 1. Prepare the release branch (if not releasing from `main`)

```bash
# Ensure your local repository is up to date
git fetch origin

# Checkout the branch you want to release from
git checkout <release-branch>  # e.g., main, release, feature/xyz
git pull origin <release-branch>

# Ensure the branch is up to date with main (if releasing from a different branch)
# This step is optional depending on your release strategy
git rebase main  # or merge, depending on your workflow
git push
```

### 2. Run the Release Workflow

1. Go to the [Actions tab](../../actions) in the GitHub repository
2. Select the "Release" workflow from the left sidebar
3. Click "Run workflow"
4. Fill in the parameters:
   - **Branch**: Select the branch to release from (e.g., `main`, `release`, `client-xxx`)
   - **Version**: Enter the version number (e.g., `0.1.0`, `1.0.0`, `2.3.1`)
5. Click "Run workflow"

### 3. Monitor the Release

The workflow will:

- Update all package.json files with the new version
- Commit the version changes
- Create a git tag `v{version}`
- Build multi-architecture Docker images (linux/amd64, linux/arm64)
- Push Docker images to GitHub Container Registry:
  - `ghcr.io/platformatic/plt-machinist-3:v{version}`
  - `ghcr.io/platformatic/plt-machinist-3:latest`

### 4. Post-Release

After a successful release:

1. **Merge Changes to Main** (if releasing from a different branch):

   ```bash
   git checkout main
   git pull origin main
   git merge origin/<release-branch>  # merge the release branch back to main
   git push origin main
   ```

2. **Update Documentation**: Update any version references in documentation

3. **Announce the Release**: Notify relevant stakeholders about the new release

## Docker Images

Released Docker images are available at:

- `ghcr.io/platformatic/plt-machinist-3:v{version}` - Specific version
- `ghcr.io/platformatic/plt-machinist-3:latest` - Latest release

To pull a specific version:

```bash
docker pull ghcr.io/platformatic/plt-machinist-3:v0.1.0
```

## Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR** version for incompatible API changes
- **MINOR** version for backwards-compatible functionality additions
- **PATCH** version for backwards-compatible bug fixes

Examples:

- `0.1.0` - Initial development release
- `1.0.0` - First stable release
- `1.1.0` - New features added
- `1.1.1` - Bug fixes

## Manual Release (Not Recommended)

If you need to perform a manual release:

1. Update version in all package.json files:

   ```bash
   # Update root package.json
   npm version 0.1.0 --no-git-tag-version

   # Update all service package.json files
   for service in services/*/; do
     if [ -f "$service/package.json" ]; then
       cd "$service"
       npm version 0.1.0 --no-git-tag-version
       cd ../..
     fi
   done
   ```

2. Commit changes:

   ```bash
   git add .
   git commit -m "chore: release v0.1.0"
   ```

3. Create and push tag:

   ```bash
   git tag -a v0.1.0 -m "Release v0.1.0"
   git push origin main
   git push origin v0.1.0
   ```

4. Build and push Docker image manually (requires Docker and proper authentication)

## Troubleshooting

### Release Workflow Fails

1. **Version Update Fails**: Ensure the version format is correct (e.g., `1.0.0`, not `v1.0.0`)
2. **Docker Build Fails**: Check the build logs for missing dependencies or build errors
3. **Permission Denied**: Ensure you have the necessary GitHub permissions

### Docker Image Issues

- Ensure `NPM_TOKEN` secret is set in GitHub repository settings for private npm packages
- Check that the Dockerfile is present and valid
- Verify GitHub Container Registry permissions