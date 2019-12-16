const Apify = require('apify');
const { extractDetail, listPageFunction } = require('./extraction.js');
const {
    getAttribute, enqueueLinks, addUrlParameters, getWorkingBrowser, fixUrl,
    isFiltered, isMinMaxPriceSet, setMinMaxPrice, isPropertyTypeSet, setPropertyType,
} = require('./util.js');

const { log } = Apify.utils;
log.setLevel(log.LEVELS.DEBUG);

const puppeteerOptions = {
    headless: true,
    useChrome: true,
    stealth: true,
    stealthOptions: {
        addPlugins: false,
        emulateWindowFrame: false,
        emulateWebGL: false,
        emulateConsoleDebug: false,
        addLanguage: false,
        hideWebDriver: true,
        hackPermissions: false,
        mockChrome: false,
        mockChromeInIframe: false,
        mockDeviceMemory: false,
    },
};

/** Main function */
Apify.main(async () => {
    // Actor INPUT variable
    const input = await Apify.getValue('INPUT');
    // Actor STATE variable
    const state = await Apify.getValue('STATE') || { crawled: {} };

    // Migrating flag
    let migrating = false;
    Apify.events.on('migrating', () => { migrating = true; });

    // Check if all required input attributes are present.
    if (!input.search && !input.startUrls) {
        throw new Error('Missing "search" or "startUrls" attribute in INPUT!');
    } else if (input.search && input.startUrls && input.search.trim().length > 0 && input.startUrls.length > 0) {
        throw new Error('It is not possible to use both "search" and "startUrls" attributes in INPUT!');
    }
    if (!(input.proxyConfig && input.proxyConfig.useApifyProxy)) {
        throw new Error('This actor cannot be used without Apify proxy.');
    }
    if (input.useFilters && input.propertyType !== 'none') {
        throw new Error('Property type and filters cannot be used at the same time.');
    }
    if (input.minScore) { input.minScore = parseFloat(input.minScore); }
    const sortBy = input.sortBy || 'bayesian_review_score';

    // Main request queue.
    const requestQueue = await Apify.openRequestQueue();

    let startUrl;
    let requestList;
    if (input.startUrls) {
        // check if attribute is an Array
        if (!Array.isArray(input.startUrls)) {
            throw new Error('INPUT.startUrls must an array!');
        }
        // convert any inconsistencies to correct format
        for (let i = 0; i < input.startUrls.length; i++) {
            let request = input.startUrls[i];
            if (typeof request === 'string') { request = { url: request }; }
            if ((!request.userData || !request.userData.label !== 'detail') && request.url.indexOf('/hotel/') > -1) {
                request.userData = { label: 'detail' };
            }
            request.url = addUrlParameters(request.url, input);
            input.startUrls[i] = request;
        }
        // create RequestList and reference startUrl
        requestList = new Apify.RequestList({ sources: input.startUrls });
        startUrl = addUrlParameters('https://www.booking.com/searchresults.html?dest_type=city&ss=paris&order=bayesian_review_score', input);
        await requestList.initialize();
    } else {
        // Create startURL based on provided INPUT.
        const dType = input.destType || 'city';
        const query = encodeURIComponent(input.search);
        startUrl = `https://www.booking.com/searchresults.html?dest_type=${dType}&ss=${query}&order=${sortBy}`;
        startUrl = addUrlParameters(startUrl, input);

        // Enqueue all pagination pages.
        startUrl += '&rows=20';
        log.info(`startUrl: ${startUrl}`);
        await requestQueue.addRequest({ url: startUrl, userData: { label: 'start' } });
        if (!input.useFilters && input.propertyType === 'none' && input.starRating === 'none' && input.maxPages) {
            for (let i = 1; i <= input.maxPages; i++) {
                await requestQueue.addRequest({
                    url: `${startUrl}&offset=${20 * i}`,
                    userData: { label: 'page' },
                });
            }
        }
    }

    // Simulated browser chache
    const cache = {};

    // Main crawler variable.
    const crawler = new Apify.PuppeteerCrawler({
        requestList,

        requestQueue,

        handlePageTimeoutSecs: 120,

        // Browser instance creation.
        launchPuppeteerFunction: () => {
            if (!input.testProxy) {
                return Apify.launchPuppeteer({
                    ...puppeteerOptions,
                    proxyUrl: 'http://proxy.apify.com:8000',
                });
            }

            return getWorkingBrowser(startUrl, input);
        },

        // Main page handling function.
        handlePageFunction: async ({ page, request, puppeteerPool }) => {
            log.info(`open url(${request.userData.label}): ${await page.url()}`);

            /** Tells the crawler to re-enqueue current page and destroy the browser.
             *  Necessary if the page was open through a not working proxy. */
            const retireBrowser = async () => {
                // console.log('proxy invalid, re-enqueuing...');
                await puppeteerPool.retire(page.browser());
                await requestQueue.addRequest(new Apify.Request({
                    url: request.url,
                    userData: request.userData,
                    uniqueKey: `${Math.random()}`,
                }));
            };

            // Check if startUrl was open correctly
            if (input.startUrls) {
                const pageUrl = await page.url();
                if (pageUrl.length < request.url.length) {
                    await retireBrowser();
                    return;
                }
            }

            // Check if page was loaded with correct currency.
            const curInput = await page.$('input[name="selected_currency"]');
            const currency = await getAttribute(curInput, 'value');

            if (!currency || currency !== input.currency) {
                await retireBrowser();
                throw new Error(`Wrong currency: ${currency}, re-enqueuing...`);
            }

            if (request.userData.label === 'detail') { // Extract data from the hotel detail page
                // wait for necessary elements
                try { await page.waitForSelector('.hprt-occupancy-occupancy-info'); } catch (e) { log.info('occupancy info not found'); }

                const ldElem = await page.$('script[type="application/ld+json"]');
                const ld = JSON.parse(await getAttribute(ldElem, 'textContent'));
                await Apify.utils.puppeteer.injectJQuery(page);

                // Check if the page was open through working proxy.
                const pageUrl = await page.url();
                if (!input.startUrls && pageUrl.indexOf('label') < 0) {
                    await retireBrowser();
                    return;
                }

                // Exit if core data is not present ot the rating is too low.
                if (!ld || (ld.aggregateRating && ld.aggregateRating.ratingValue <= (input.minScore || 0))) {
                    return;
                }

                // Extract the data.
                log.info('extracting detail...');
                const detail = await extractDetail(page, ld, input, request.userData);
                log.info('detail extracted');
                await Apify.pushData(detail);
            } else {
                // Handle hotel list page.
                const filtered = await isFiltered(page);
                const settingFilters = input.useFilters && !filtered;
                const settingMinMaxPrice = input.minMaxPrice !== 'none' && !await isMinMaxPriceSet(page, input);
                const settingPropertyType = input.propertyType !== 'none' && !await isPropertyTypeSet(page, input);
                const enqueuingReady = !(settingFilters || settingMinMaxPrice || settingPropertyType);

                // Check if the page was open through working proxy.
                let pageUrl = await page.url();
                if (!input.startUrls && pageUrl.indexOf(sortBy) < 0) {
                    await retireBrowser();
                    return;
                }

                // If it's aprropriate, enqueue all pagination pages
                if (enqueuingReady && (!input.maxPages || input.minMaxPrice || input.propertyType)) {
                    const baseUrl = await page.url();
                    if (baseUrl.indexOf('offset') < 0) {
                        log.info('enqueuing pagination pages...');
                        const pageSelector = '.bui-pagination__list a:not([aria-current])';
                        const countSelector = '.sorth1, .sr_header h1, .sr_header h2';
                        try {
                            await page.waitForSelector(pageSelector, { timeout: 60000 });
                            const pageElem = await page.$(pageSelector);
                            pageUrl = await getAttribute(pageElem, 'href');
                            await page.waitForSelector(countSelector);
                            const countElem = await page.$(countSelector);
                            const countData = (await getAttribute(countElem, 'textContent')).replace(/\.|,|\s/g, '').match(/\d+/);
                            if (countData) {
                                const count = Math.ceil(parseInt(countData[0], 10) / 20);
                                log.info(`pagination pages: ${count}`);
                                for (let i = 0; i < count; i++) {
                                    const newUrl = pageUrl.replace(/rows=(\d+)/, 'rows=20').replace(/offset=(\d+)/, `offset=${20 * i}`);
                                    await requestQueue.addRequest(new Apify.Request({
                                        url: addUrlParameters(newUrl, input),
                                        // url: baseUrl + '&rows=20&offset=' + 20*i,
                                        userData: { label: 'page' },
                                    }));
                                }
                            }
                        } catch (e) {
                            log.info(e);
                            await Apify.setValue('count_error.html', await page.content(), { contentType: 'text/html' });
                        }
                    }
                }

                // If property type is enabled, enqueue necessary page.
                if (settingPropertyType) {
                    await setPropertyType(page, input, requestQueue);
                }

                // If min-max price is enabled, enqueue necessary page.
                if (settingMinMaxPrice && !settingPropertyType) {
                    await setMinMaxPrice(page, input, requestQueue);
                }

                // If filtering is enabled, enqueue necessary pages.
                if (input.useFilters && !filtered) {
                    log.info('enqueuing filtered pages...');

                    await enqueueLinks(page, requestQueue, '.filterelement', null, 'page', fixUrl('&', input), async (link) => {
                        const lText = await getAttribute(link, 'textContent');
                        return `${lText}_0`;
                    });
                }

                if (enqueuingReady && input.simple) { // If simple output is enough, extract the data.
                    log.info('extracting data...');
                    await Apify.setValue('page.html', await page.content(), { contentType: 'text/html' });
                    await Apify.utils.puppeteer.injectJQuery(page);
                    const result = await page.evaluate(listPageFunction, input);
                    log.info(`Found ${result.length} results`);
                    if (result.length > 0) {
                        const toBeAdded = [];
                        for (const item of result) {
                            item.url = addUrlParameters(item.url, input);
                            if (!state.crawled[item.name]) {
                                toBeAdded.push(item);
                                state.crawled[item.name] = true;
                            }
                        }
                        if (migrating) { await Apify.setValue('STATE', state); }
                        if (toBeAdded.length > 0) { await Apify.pushData(toBeAdded); }
                    }
                } else if (enqueuingReady) { // If not, enqueue the detail pages to be extracted.
                    log.info('enqueuing detail pages...');
                    // await enqueueLinks(page, requestQueue, '.hotel_name_link', null, 'detail',
                    //    fixUrl('&', input), (link) => getAttribute(link, 'textContent'));
                    const urlMod = fixUrl('&', input);
                    const keyMod = link => getAttribute(link, 'textContent');
                    const prItem = await page.$('.bui-pagination__info');
                    const pageRange = (await getAttribute(prItem, 'textContent')).match(/\d+/g);
                    const firstItem = parseInt(pageRange[0], 10);
                    const links = await page.$$('.hotel_name_link');
                    for (let iLink = 0; iLink < links.length; iLink++) {
                        const link = links[iLink];
                        const href = await getAttribute(link, 'href');
                        if (href) {
                            await requestQueue.addRequest({
                                userData: {
                                    label: 'detail',
                                    order: iLink + firstItem,
                                },
                                url: urlMod ? urlMod(href) : href,
                                uniqueKey: keyMod ? (await keyMod(link)) : href,
                            }, { forefront: true });
                        }
                    }
                }
            }
        },

        // Failed request handling
        handleFailedRequestFunction: async ({ request }) => {
            await Apify.pushData({
                url: request.url,
                succeeded: false,
                errors: request.errorMessages,
            });
        },

        // Function for ignoring all unnecessary requests.
        gotoFunction: async ({ page, request }) => {
            await page.setRequestInterception(true);

            page.on('request', async (nRequest) => {
                const url = nRequest.url();
                if (url.includes('.js')) nRequest.abort();
                else if (url.includes('.png')) nRequest.abort();
                else if (url.includes('.jpg')) nRequest.abort();
                else if (url.includes('.gif')) nRequest.abort();
                else if (url.includes('.css')) nRequest.abort();
                else if (url.includes('static/fonts')) nRequest.abort();
                else if (url.includes('js_tracking')) nRequest.abort();
                else if (url.includes('facebook.com')) nRequest.abort();
                else if (url.includes('googleapis.com')) nRequest.abort();
                else if (url.includes('secure.booking.com')) nRequest.abort();
                else if (url.includes('booking.com/logo')) nRequest.abort();
                else if (url.includes('booking.com/navigation_times')) nRequest.abort();
                else {
                    // Return cached response if available
                    if (cache[url] && cache[url].expires > Date.now()) {
                        await nRequest.respond(cache[url]);
                        return;
                    }
                    nRequest.continue();
                }
            });

            // Cache responses for future needs
            page.on('response', async (response) => {
                const url = response.url();
                const headers = response.headers();
                const cacheControl = headers['cache-control'] || '';
                const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
                const maxAge = maxAgeMatch && maxAgeMatch.length > 1 ? parseInt(maxAgeMatch[1], 10) : 0;
                if (maxAge && input.cacheResponses) {
                    if (!cache[url] || cache[url].expires > Date.now()) return;

                    cache[url] = {
                        status: response.status(),
                        headers: response.headers(),
                        body: response.buffer(),
                        expires: Date.now() + (maxAge * 1000),
                    };
                }
            });

            const proxyUsername = `groups-${input.proxyConfig.apifyProxyGroups},session-123`;
            log.info(proxyUsername);

            await page.authenticate({
                username: proxyUsername,
                password: `${process.env.APIFY_PROXY_PASSWORD}`,
            });

            // Hide WebDriver and randomize the request.
            const userAgent = Apify.utils.getRandomUserAgent();
            await page.setUserAgent(userAgent);
            const cookies = await page.cookies('https://www.booking.com');
            await page.deleteCookie(...cookies);
            await page.viewport({
                width: 1024 + Math.floor(Math.random() * 100),
                height: 768 + Math.floor(Math.random() * 100),
            });
            return page.goto(request.url, { timeout: 200000 });
        },
    });

    // Start the crawler.
    await crawler.run();
});
