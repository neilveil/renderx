import * as cheerio from 'cheerio'
import { logger } from './logger'

export interface HtmlOptimizerOptions {
    removeDataAttributes?: boolean // Remove data-* attributes (default: true)
    removeAriaAttributes?: boolean // Remove aria-* attributes (default: true)
    removeStyleAttributes?: boolean // Remove style attributes (default: true)
    removeInlineStyles?: boolean // Remove <style> tags (default: true)
}

/**
 * Optimizes HTML for SEO and social sharing by removing unnecessary scripts, styles, and links
 * while preserving essential meta tags and content
 * @param html - HTML string to optimize
 * @param options - Configuration options for what to remove
 */
export const optimizeHtmlForSEO = (html: string, options: HtmlOptimizerOptions = {}): string => {
    const {
        removeDataAttributes = true,
        removeAriaAttributes = true,
        removeStyleAttributes = true,
        removeInlineStyles = true
    } = options
    try {
        const $ = cheerio.load(html)

        // Remove all script tags except JSON-LD structured data
        $('script').each((_, el) => {
            const scriptType = $(el).attr('type')
            if (scriptType !== 'application/ld+json') {
                $(el).remove()
            }
        })

        // Remove preload, prefetch, dns-prefetch, and modulepreload links
        $('link[rel="preload"], link[rel="prefetch"], link[rel="dns-prefetch"], link[rel="modulepreload"]').remove()

        // Remove preconnect links
        $('link[rel="preconnect"]').remove()

        // Remove all stylesheet links
        $('link[rel="stylesheet"]').remove()

        // Remove all inline style tags (if enabled)
        if (removeInlineStyles) {
            $('style').remove()
        }

        // Handle favicons: keep only essential ones
        let manifestKept = false
        let faviconKept = false
        let appleIconKept = false
        // Store reference to the element we want to keep
        let appleIcon180: unknown = null

        // First pass: find the apple-touch-icon 180x180 if it exists
        $('link[rel="apple-touch-icon"]').each((_, el) => {
            const sizes = $(el).attr('sizes')
            if (sizes && sizes.includes('180x180')) {
                appleIcon180 = el
            }
        })

        // Second pass: remove duplicates
        $('link').each((_, el) => {
            const rel = $(el).attr('rel')
            if (rel === 'manifest') {
                if (manifestKept) {
                    $(el).remove()
                } else {
                    manifestKept = true
                }
            } else if (rel === 'icon' && !$(el).attr('rel')?.includes('apple-touch-icon')) {
                if (faviconKept) {
                    $(el).remove()
                } else {
                    faviconKept = true
                }
            } else if (rel === 'apple-touch-icon') {
                if (appleIcon180 && el === appleIcon180) {
                    // Keep the 180x180 icon, remove others
                    if (!appleIconKept) {
                        appleIconKept = true
                    }
                } else if (appleIcon180) {
                    // Remove other sizes if 180x180 exists
                    $(el).remove()
                } else if (appleIconKept) {
                    // Remove duplicates if no 180x180
                    $(el).remove()
                } else {
                    appleIconKept = true
                }
            }
        })

        // Remove mask-icon (Safari pinned tab) - not essential for SEO
        $('link[rel="mask-icon"]').remove()

        // Remove msapplication meta tags (Windows tiles) - not essential for SEO
        $('meta[name^="msapplication"]').remove()

        // Remove data-testid attributes (testing attributes, not needed)
        $('[data-testid]').removeAttr('data-testid')

        // Remove next-head-count meta (Next.js internal, not needed)
        $('meta[name="next-head-count"]').remove()

        // Remove HTML comments (not needed for SEO)
        $('*')
            .contents()
            .filter(function () {
                return this.nodeType === 8 // Comment node
            })
            .remove()

        // Remove noscript tags (bots don't need fallback content)
        $('noscript').remove()

        // Remove hidden elements (not visible to bots anyway)
        $('[hidden], [style*="display:none"], [style*="display: none"], [style*="visibility:hidden"]').remove()

        // Remove data-* attributes (not needed for SEO, except keep data-* in meta tags)
        if (removeDataAttributes) {
            $('*')
                .not('meta')
                .each((_, el) => {
                    const $el = $(el)
                    const element = $el.get(0)
                    if (element && 'attribs' in element && element.attribs) {
                        const attribs = element.attribs as Record<string, string>
                        Object.keys(attribs).forEach(attr => {
                            if (attr.startsWith('data-')) {
                                $el.removeAttr(attr)
                            }
                        })
                    }
                })
        }

        // Remove aria-* attributes (accessibility, not needed for SEO)
        if (removeAriaAttributes) {
            $('*').each((_, el) => {
                const $el = $(el)
                const element = $el.get(0)
                if (element && 'attribs' in element && element.attribs) {
                    const attribs = element.attribs as Record<string, string>
                    Object.keys(attribs).forEach(attr => {
                        if (attr.startsWith('aria-')) {
                            $el.removeAttr(attr)
                        }
                    })
                }
            })
        }

        // Remove event handler attributes (onclick, onerror, etc.)
        $('*').each((_, el) => {
            const $el = $(el)
            const element = $el.get(0)
            if (element && 'attribs' in element && element.attribs) {
                const attribs = element.attribs as Record<string, string>
                Object.keys(attribs).forEach(attr => {
                    if (attr.startsWith('on')) {
                        $el.removeAttr(attr)
                    }
                })
            }
        })

        // Remove inline style attributes (not needed for SEO)
        if (removeStyleAttributes) {
            $('*').removeAttr('style')
        }

        // Note: Class and ID removal is disabled by default as it may break pages that rely on them.
        // Uncomment the line below if you want to remove classes/IDs for smaller HTML size.
        // This is generally safe for SEO as bots don't need CSS, but may affect page structure.
        // $('body *').removeAttr('class').removeAttr('id')

        // Remove empty elements (except essential ones)
        $('body *').each((_, el) => {
            const $el = $(el)
            const tagName = $el.prop('tagName')?.toLowerCase()
            const text = $el.text().trim()
            const children = $el.children().length
            const element = $el.get(0)
            const hasAttributes = element && 'attribs' in element && element.attribs && Object.keys(element.attribs).length > 0

            // Remove empty elements (except script, style, meta, link, img, br, hr, input)
            const keepTags = [
                'script',
                'style',
                'meta',
                'link',
                'img',
                'br',
                'hr',
                'input',
                'source',
                'track',
                'area',
                'col',
                'embed',
                'param',
                'wbr'
            ]

            if (!keepTags.includes(tagName || '') && !text && !children && !hasAttributes) {
                $el.remove()
            }
        })

        // Minify whitespace in text nodes (but preserve structure)
        $('body')
            .find('*')
            .each((_, el) => {
                const $el = $(el)
                $el.contents()
                    .filter(function () {
                        return this.nodeType === 3 // Text node
                    })
                    .each(function () {
                        const text = $(this).text()
                        if (text.trim() === '') {
                            $(this).remove()
                        } else {
                            $(this).replaceWith(text.replace(/\s+/g, ' ').trim())
                        }
                    })
            })

        // Get optimized HTML and minify it
        let optimized = $.html()

        // Additional minification: remove extra whitespace between tags
        optimized = optimized.replace(/>\s+</g, '><')

        // Remove whitespace at start/end of lines (but keep single spaces)
        optimized = optimized.replace(/^\s+|\s+$/gm, '')

        // Remove multiple spaces (but keep single space)
        optimized = optimized.replace(/  +/g, ' ')

        return optimized
    } catch (err) {
        logger.error('Error optimizing HTML:', err)
        // Return original HTML if optimization fails
        return html
    }
}
