<#
.SYNOPSIS
  Publish dsh-seesion-copy-enhance to GitHub and npm without a local git install.

.DESCRIPTION
  Uses the GitHub REST "Git Data" API so no git binary is required, then runs
  `npm publish`. Both steps are idempotent-ish: an existing repository is reused,
  a matching tree is not re-sent, and the release is only created when missing.

  Required environment variables:
    GITHUB_TOKEN   fine-grained PAT or classic PAT with repo + workflow scope
    NPM_TOKEN      npm automation token (publish rights on the package name)

  Optional:
    GITHUB_REPO    "owner/name" (default: <authenticated user>/dsh-seesion-copy-enhance)
    SKIP_GITHUB    set to 1 to only publish to npm
    SKIP_NPM       set to 1 to only push to GitHub

.EXAMPLE
  $env:GITHUB_TOKEN = 'ghp_...'; $env:NPM_TOKEN = 'npm_...'
  pwsh -File scripts/publish.ps1
#>
[CmdletBinding()]
param(
    [string] $Repository,
    [switch] $NoNpm,
    [switch] $NoGithub
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Assert-Command([string] $name) {
    if ($null -eq (Get-Command $name -ErrorAction SilentlyContinue)) {
        throw "missing required command: $name"
    }
}

function Read-Json($response) {
    $text = $response.Content
    if ($text -is [byte[]]) { $text = [System.Text.Encoding]::UTF8.GetString($text) }
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
}

function Invoke-GitHub {
    param(
        [Parameter(Mandatory)] [string] $Method,
        [Parameter(Mandatory)] [string] $Path,
        $Body,
        [switch] $AllowFailure
    )
    $headers = @{
        Authorization          = "Bearer $env:GITHUB_TOKEN"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'dsh-seesion-copy-enhance-release'
    }
    $parameters = @{
        Method      = $Method
        Uri         = "https://api.github.com$Path"
        Headers     = $headers
        ContentType = 'application/json; charset=utf-8'
    }
    if ($null -ne $Body) {
        $parameters.Body = ([System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 20 -Compress)))
    }
    try {
        return Invoke-WebRequest @parameters -UseBasicParsing
    } catch {
        if ($AllowFailure) { return $_.Exception.Response }
        $detail = $_.ErrorDetails.Message
        throw "GitHub $Method $Path failed: $($_.Exception.Message) $detail"
    }
}

$package = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
$slug = $package.name

# --------------------------------------------------------------------------
# GitHub
# --------------------------------------------------------------------------
$owner = $null
if (-not $NoGithub -and -not $env:SKIP_GITHUB) {
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) { throw 'GITHUB_TOKEN is not set' }

    $me = Read-Json (Invoke-GitHub -Method GET -Path '/user')
    $owner = $me.login
    Write-Host "GitHub user: $owner"

    if ([string]::IsNullOrWhiteSpace($Repository)) {
        $Repository = if ([string]::IsNullOrWhiteSpace($env:GITHUB_REPO)) { "$owner/$slug" } else { $env:GITHUB_REPO }
    }
    $parts = $Repository.Split('/')
    $repoOwner = $parts[0]
    $repoName = $parts[1]
    Write-Host "Target repository: $repoOwner/$repoName"

    $description = $package.description
    $repoBody = @{
        name        = $repoName
        description = $description
        homepage    = "https://www.npmjs.com/package/$slug"
        private     = $false
        has_issues  = $true
        has_wiki    = $false
        auto_init   = $false
    }
    $existing = Invoke-GitHub -Method GET -Path "/repos/$repoOwner/$repoName" -AllowFailure
    if ($existing.StatusCode -eq 200) {
        Write-Host 'Repository already exists; updating description.'
        Invoke-GitHub -Method PATCH -Path "/repos/$repoOwner/$repoName" -Body @{ description = $description; homepage = $repoBody.homepage } | Out-Null
    } else {
        Invoke-GitHub -Method POST -Path $(if ($repoOwner -eq $owner) { '/user/repos' } else { "/orgs/$repoOwner/repos" }) -Body $repoBody | Out-Null
        Write-Host 'Repository created.'
    }

    # A brand-new repository has no commit, and the blob API refuses to run on an
    # empty repository ("Git Repository is empty", HTTP 409). Seed one commit
    # through the contents API first; the tree below replaces it entirely.
    $seeded = Invoke-GitHub -Method GET -Path "/repos/$repoOwner/$repoName/git/ref/heads/main" -AllowFailure
    if ($seeded.StatusCode -ne 200) {
        $seedBody = @{
            message = 'chore: initialise repository'
            content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("seed`n"))
        }
        try {
            Invoke-GitHub -Method PUT -Path "/repos/$repoOwner/$repoName/contents/.gitkeep" -Body $seedBody | Out-Null
        } catch {
            Invoke-GitHub -Method PUT -Path "/repos/$repoOwner/$repoName/contents/README.md" -Body @{
                message = 'chore: initialise repository'
                content = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes("# $slug`n"))
            } | Out-Null
        }
        Write-Host 'Seeded the first commit.'
    }

    # Point the manifest at the real repository before committing.
    $ownerPlaceholder = 'OWNER'
    foreach ($file in @('package.json', 'README.md', 'README.zh.md')) {
        $path = Join-Path $root $file
        if (-not (Test-Path $path)) { continue }
        $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        $updated = $text.Replace("github.com/$ownerPlaceholder/", "github.com/$repoOwner/")
        if ($updated -ne $text) {
            [System.IO.File]::WriteAllText($path, $updated, (New-Object System.Text.UTF8Encoding($false)))
            Write-Host "Rewrote $file with $repoOwner"
        }
    }

    # ---------------- blobs + tree ----------------
    $files = Get-ChildItem -Recurse -File | Where-Object {
        $_.FullName -notmatch '\\node_modules\\' -and
        $_.FullName -notmatch '\\\.git\\' -and
        $_.Name -notmatch '\.tgz$'
    }
    $treeEntries = New-Object System.Collections.ArrayList
    $skipped = New-Object System.Collections.ArrayList
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($root.Length + 1).Replace('\', '/')
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        try {
            $blob = Read-Json (Invoke-GitHub -Method POST -Path "/repos/$repoOwner/$repoName/git/blobs" -Body @{
                    content  = [Convert]::ToBase64String($bytes)
                    encoding = 'base64'
                })
        } catch {
            # A token without the `workflow` scope cannot create .github/workflows
            # files; upload the rest and tell the user what to add by hand.
            if ($relative -match '^\.github/workflows/') {
                [void]$skipped.Add($relative)
                continue
            }
            throw
        }
        [void]$treeEntries.Add(@{ path = $relative; mode = '100644'; type = 'blob'; sha = $blob.sha })
        Write-Verbose "blob $relative"
    }
    Write-Host "Uploaded $($treeEntries.Count) blobs."
    if ($skipped.Count -gt 0) {
        Write-Warning "Token lacks the workflow scope; add these files through the web UI: $($skipped -join ', ')"
    }

    $tree = Read-Json (Invoke-GitHub -Method POST -Path "/repos/$repoOwner/$repoName/git/trees" -Body @{ tree = $treeEntries })

    $head = Invoke-GitHub -Method GET -Path "/repos/$repoOwner/$repoName/git/ref/heads/main" -AllowFailure
    $parents = @()
    if ($head.StatusCode -eq 200) {
        $parents = @((Read-Json $head).object.sha)
    }

    $commitBody = @{
        message = "release: v$version"
        tree    = $tree.sha
    }
    if ($parents.Count -gt 0) { $commitBody.parents = $parents }
    $commit = Read-Json (Invoke-GitHub -Method POST -Path "/repos/$repoOwner/$repoName/git/commits" -Body $commitBody)
    Write-Host "Commit $($commit.sha)"

    if ($parents.Count -eq 0) {
        Invoke-GitHub -Method POST -Path "/repos/$repoOwner/$repoName/git/refs" -Body @{ ref = 'refs/heads/main'; sha = $commit.sha } | Out-Null
    } else {
        Invoke-GitHub -Method PATCH -Path "/repos/$repoOwner/$repoName/git/refs/heads/main" -Body @{ sha = $commit.sha; force = $true } | Out-Null
    }
    Write-Host 'Pushed main.'

    # ---------------- release ----------------
    $tag = "v$version"
    $release = Invoke-GitHub -Method GET -Path "/repos/$repoOwner/$repoName/releases/tags/$tag" -AllowFailure
    if ($release.StatusCode -ne 200) {
        $notes = if (Test-Path (Join-Path $root 'CHANGELOG.md')) {
            (Get-Content (Join-Path $root 'CHANGELOG.md') -Raw)
        } else { "v$version" }
        Invoke-GitHub -Method POST -Path "/repos/$repoOwner/$repoName/releases" -Body @{
            tag_name         = $tag
            target_commitish = 'main'
            name             = "$slug v$version"
            body             = $notes
            draft            = $false
            prerelease       = $false
        } | Out-Null
        Write-Host "Release $tag created."
    } else {
        Write-Host "Release $tag already exists."
    }

    Write-Host "Repository: https://github.com/$repoOwner/$repoName"
}

# --------------------------------------------------------------------------
# npm
# --------------------------------------------------------------------------
if (-not $NoNpm -and -not $env:SKIP_NPM) {
    if ([string]::IsNullOrWhiteSpace($env:NPM_TOKEN)) { throw 'NPM_TOKEN is not set' }
    Assert-Command 'npm'
    $registry = 'https://registry.npmjs.org'
    Write-Host "Publishing $slug@$version to $registry"
    & npm publish --access public --registry $registry "--//registry.npmjs.org/:_authToken=$env:NPM_TOKEN"
    if ($LASTEXITCODE -ne 0) { throw "npm publish failed with exit code $LASTEXITCODE" }
    Write-Host "Published: https://www.npmjs.com/package/$slug"
}
