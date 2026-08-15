// Link-and-asset integrity tests for the static site.
//
//   npm test                     # everything, including the two network probes
//   SKIP_NETWORK_TESTS=1 npm test  # local-only (offline / air-gapped CI)
//
// The offline checks are the ones that must never flake: they only touch the
// working tree. The network probes skip (rather than fail) when the network is
// unreachable or the host rate-limits us, so a red run always means a real
// broken link.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const PAGES = ['index.html', 'privacy.html']

// Where the site is actually served from. GitHub Pages project sites live under
// a subpath, so absolute-from-root refs ("/images/x.png") would 404 in prod.
const SITE_BASE = 'https://nimomix.github.io/safeus/'

// Directories whose every file is expected to be referenced by some page.
const ASSET_DIRS = ['images']

// Meta tags that carry a URL in their content attribute.
const URL_META_KEYS = new Set(['og:image', 'og:url', 'twitter:image'])

const NETWORK_TIMEOUT_MS = 20_000
// apps.apple.com answers 429 to generic clients; a browser UA gets a real 200.
const BROWSER_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
// Bot mitigation / transient upstream trouble — not evidence of a bad link.
const INCONCLUSIVE_STATUSES = new Set([403, 429, 503])

const EXTERNAL_URLS_UNDER_TEST = [
    'https://apps.apple.com/app/safeus/id6761664686',
    'https://nimomix.github.io',
]

/* ---------------------------------------------------------------- helpers */

const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8')

const lineOf = (haystack, index) => haystack.slice(0, index).split('\n').length

/**
 * Existence check that is case-sensitive even on macOS's case-insensitive
 * filesystem, by matching each path segment against its parent's listing.
 * GitHub Pages *is* case-sensitive, so "images/Home-Light.png" must fail here
 * even though fs.existsSync() would happily say it exists locally.
 */
function existsCaseSensitive(relPath) {
    let dir = ROOT
    for (const segment of relPath.split('/')) {
        if (segment === '') continue
        let entries
        try {
            entries = fs.readdirSync(dir)
        } catch {
            return false
        }
        if (!entries.includes(segment)) return false
        dir = path.join(dir, segment)
    }
    return true
}

function walkFiles(relDir) {
    const out = []
    for (const entry of fs.readdirSync(path.join(ROOT, relDir), { withFileTypes: true })) {
        const rel = `${relDir}/${entry.name}`
        if (entry.isDirectory()) out.push(...walkFiles(rel))
        else out.push(rel)
    }
    return out
}

/** Collect src/href attributes, CSS url(...) values and URL-bearing meta tags. */
function collectRefs(page) {
    const html = read(page)
    const refs = []
    const push = (value, index, kind) =>
        refs.push({ value, kind, page, line: lineOf(html, index), where: `${page}:${lineOf(html, index)}` })

    const attr = /\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
    for (let m; (m = attr.exec(html)); ) push(m[2] ?? m[3], m.index, m[1].toLowerCase())

    const cssUrl = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi
    for (let m; (m = cssUrl.exec(html)); ) push(m[2].trim(), m.index, 'css-url')

    const meta = /<meta\b[^>]*>/gi
    for (let m; (m = meta.exec(html)); ) {
        const tag = m[0]
        const key = /\b(?:property|name)\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
        const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
        const keyName = (key?.[1] ?? key?.[2] ?? '').toLowerCase()
        if (!URL_META_KEYS.has(keyName) || !content) continue
        push(content[1] ?? content[2], m.index, `meta:${keyName}`)
    }

    return refs
}

const ALL_REFS = PAGES.flatMap(collectRefs)

const isExternal = (value) => /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')

/** Refs that must resolve to a file in this repo, normalised to repo-relative paths. */
function localRefs() {
    const out = []
    for (const ref of ALL_REFS) {
        const { value } = ref
        if (value === '' || value.startsWith('#') || isExternal(value)) {
            // A same-origin absolute URL still points at a file we ship.
            if (value.startsWith(SITE_BASE)) {
                out.push({ ...ref, target: value.slice(SITE_BASE.length).split(/[?#]/)[0], absolute: true })
            }
            continue
        }
        // Strip any leading slash so a root-absolute ref still resolves for the
        // exists/stray checks — it is flagged on its own by the "stay relative" test.
        out.push({ ...ref, target: value.split(/[?#]/)[0].replace(/^\/+/, ''), absolute: false })
    }
    return out
}

const LOCAL_REFS = localRefs()

const mailtoRefs = () =>
    ALL_REFS.filter((r) => r.value.toLowerCase().startsWith('mailto:'))
        .map((r) => ({ ...r, address: r.value.slice('mailto:'.length).split('?')[0] }))

async function probe(url) {
    const init = {
        redirect: 'follow',
        headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,*/*' },
    }
    const attempt = async (method) =>
        fetch(url, { ...init, method, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })

    let res
    try {
        res = await attempt('HEAD')
        // Plenty of CDNs dislike HEAD; confirm with a GET before believing a failure.
        if (!res.ok) res = await attempt('GET')
    } catch (error) {
        return { networkError: error?.cause?.message ?? error?.message ?? String(error) }
    }
    return { status: res.status, finalUrl: res.url }
}

/* ------------------------------------------------------------------ tests */

test('both pages are present and parseable', () => {
    for (const page of PAGES) {
        assert.ok(existsCaseSensitive(page), `${page} is missing`)
        assert.match(read(page), /<html\b/i, `${page} has no <html> element`)
    }
    assert.ok(ALL_REFS.length > 0, 'no src/href references were extracted — the parser is broken')
})

test('every local src/href resolves to a file on disk', () => {
    const missing = LOCAL_REFS.filter((r) => !existsCaseSensitive(r.target)).map(
        (r) => `${r.where} → ${r.value}`,
    )
    assert.deepEqual(missing, [], `broken local references:\n  ${missing.join('\n  ')}`)
})

test('local references are case-exact (GitHub Pages is case-sensitive)', () => {
    // existsCaseSensitive() already enforces this, so this test pins the *reason*:
    // a ref that only resolves after lower-casing would ship broken.
    const wrongCase = LOCAL_REFS.filter((r) => {
        if (existsCaseSensitive(r.target)) return false
        return fs.existsSync(path.join(ROOT, r.target)) // exists, but under different casing
    }).map((r) => `${r.where} → ${r.value}`)
    assert.deepEqual(wrongCase, [], `case-mismatched references:\n  ${wrongCase.join('\n  ')}`)
})

test('local references stay relative and inside the site root', () => {
    const offenders = LOCAL_REFS.filter((r) => r.absolute === false)
        .filter((r) => r.value.startsWith('/') || r.target.split('/').includes('..'))
        .map((r) => `${r.where} → ${r.value}`)
    assert.deepEqual(
        offenders,
        [],
        `refs must be relative — the site is served from ${SITE_BASE}, so root-absolute ` +
            `paths 404 in production:\n  ${offenders.join('\n  ')}`,
    )
})

test('no reference or shipped asset has a space or needs percent-encoding', () => {
    const spacedRefs = LOCAL_REFS.filter((r) => /\s/.test(r.value) || /%[0-9a-f]{2}/i.test(r.value)).map(
        (r) => `${r.where} → ${JSON.stringify(r.value)}`,
    )
    assert.deepEqual(spacedRefs, [], `refs with spaces / encoded chars:\n  ${spacedRefs.join('\n  ')}`)

    const spacedFiles = ASSET_DIRS.flatMap(walkFiles).filter((f) => /\s/.test(f))
    assert.deepEqual(spacedFiles, [], `asset filenames must not contain spaces: ${spacedFiles.join(', ')}`)
})

test('no stray unreferenced assets are shipped', () => {
    const referenced = new Set(LOCAL_REFS.map((r) => r.target))
    const stray = ASSET_DIRS.flatMap(walkFiles).filter((f) => !referenced.has(f))
    assert.deepEqual(
        stray,
        [],
        `unreferenced files under ${ASSET_DIRS.join(', ')}/ — delete them or link them:\n  ${stray.join('\n  ')}`,
    )
})

test('the two pages link to each other', () => {
    const hrefsOn = (page) => ALL_REFS.filter((r) => r.page === page && r.kind === 'href').map((r) => r.value)
    assert.ok(hrefsOn('index.html').includes('privacy.html'), 'index.html must link to privacy.html')
    assert.ok(hrefsOn('privacy.html').includes('index.html'), 'privacy.html must link back to index.html')
})

test('in-page anchors point at an element that exists', () => {
    const dangling = []
    for (const ref of ALL_REFS) {
        if (!ref.value.startsWith('#') || ref.value === '#') continue
        const id = ref.value.slice(1)
        const html = read(ref.page)
        const found = new RegExp(`\\b(?:id|name)\\s*=\\s*(?:"${id}"|'${id}')`).test(html)
        if (!found) dangling.push(`${ref.where} → ${ref.value}`)
    }
    assert.deepEqual(dangling, [], `dangling in-page anchors:\n  ${dangling.join('\n  ')}`)
})

test('social preview meta tags use absolute URLs that resolve locally', () => {
    const metaRefs = ALL_REFS.filter((r) => r.kind.startsWith('meta:'))
    const imageRefs = metaRefs.filter((r) => r.kind.endsWith(':image'))
    assert.ok(imageRefs.length > 0, 'expected og:image / twitter:image tags on index.html')

    for (const ref of imageRefs) {
        assert.ok(
            ref.value.startsWith('https://'),
            `${ref.where}: ${ref.kind} must be an absolute https URL (scrapers do not resolve relative ones), got ${ref.value}`,
        )
        assert.ok(
            ref.value.startsWith(SITE_BASE),
            `${ref.where}: ${ref.kind} should be served from ${SITE_BASE}, got ${ref.value}`,
        )
    }

    for (const ref of metaRefs.filter((r) => r.kind === 'meta:og:url')) {
        assert.equal(ref.value, SITE_BASE, `${ref.where}: og:url must match the canonical site URL`)
    }
})

test('every external link is a valid absolute https URL', () => {
    const bad = []
    for (const ref of ALL_REFS) {
        const { value } = ref
        if (!isExternal(value) || value.toLowerCase().startsWith('mailto:')) continue
        if (ref.kind.startsWith('meta:')) continue
        if (!value.startsWith('https://')) {
            bad.push(`${ref.where} → ${value} (not https)`)
            continue
        }
        try {
            new URL(value)
        } catch {
            bad.push(`${ref.where} → ${value} (unparseable)`)
        }
    }
    assert.deepEqual(bad, [], `bad external links:\n  ${bad.join('\n  ')}`)
})

test('mailto: contact address is well-formed and consistent across pages', () => {
    const mailtos = mailtoRefs()
    assert.ok(mailtos.length > 0, 'expected at least one mailto: contact link')

    // Deliberately strict: one address, no spaces, no stray punctuation.
    const ADDRESS = /^[^\s@,;<>"']+@[^\s@,;<>"'.]+(?:\.[^\s@,;<>"'.]+)+$/
    for (const ref of mailtos) {
        assert.match(ref.address, ADDRESS, `${ref.where}: malformed mailto address ${JSON.stringify(ref.address)}`)
        assert.ok(!ref.address.includes('%20'), `${ref.where}: mailto address contains an encoded space`)
    }

    const unique = [...new Set(mailtos.map((r) => r.address.toLowerCase()))]
    assert.equal(
        unique.length,
        1,
        `all pages must advertise the same contact address, found: ${unique.join(', ')}`,
    )
})

for (const url of EXTERNAL_URLS_UNDER_TEST) {
    test(`${url} responds 2xx`, { skip: process.env.SKIP_NETWORK_TESTS === '1' && 'SKIP_NETWORK_TESTS=1' }, async (t) => {
        const referenced = ALL_REFS.some((r) => r.value === url)
        assert.ok(referenced, `${url} is no longer referenced by any page — update EXTERNAL_URLS_UNDER_TEST`)

        const result = await probe(url)
        if (result.networkError) {
            t.skip(`network unavailable: ${result.networkError}`)
            return
        }
        if (INCONCLUSIVE_STATUSES.has(result.status)) {
            t.skip(`inconclusive: host returned ${result.status} (bot mitigation / transient)`)
            return
        }
        assert.ok(
            result.status >= 200 && result.status < 300,
            `expected 2xx, got ${result.status} (final URL: ${result.finalUrl})`,
        )
    })
}
