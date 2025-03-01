/**
 * MIT License
 *
 * Copyright (c) 2018 Simo Ahava
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const {URL} = require(`url`);
const fs = require(`fs`);
const {promisify} = require(`util`);

const puppeteer = require(`puppeteer`);
const lighthouse = require(`lighthouse`);
const uuidv1 = require(`uuid/v1`);
const {Validator} = require(`jsonschema`);
const requestGet = promisify(require('request').get)

const {BigQuery} = require(`@google-cloud/bigquery`);
const {PubSub} = require(`@google-cloud/pubsub`);
const {Storage} = require(`@google-cloud/storage`);

const bqSchema = require(`./bigquery-schema.json`);
const config = require(`./config.json`);
const configSchema = require(`./config.schema.json`);

// Make filesystem write work with async/await
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

// Initialize new GC clients
const bigquery = new BigQuery({
  projectId: config.projectId
});
const pubsub = new PubSub({
  projectId: config.projectId
});
const storage = new Storage({
  projectId: config.projectId
});

const validator = new Validator;

const log = console.log;

const separator = '_';
const thirdPartyBlocked = '3PBlocked';
const thirdPartyIncluded = '3PIncluded';

/**
 * Function that runs lighthouse in a headless browser instance.
 *
 * @param {string} id ID of the source for logging purposes.
 * @param {string} url URL to audit.
 * @returns {Promise<object>} The object containing the lighthouse report.
 */
async function launchBrowserWithLighthouse(id, url, lighthouseFlags) {

  log(`${id}: Starting browser for ${url}`);
  try {
    const browser = await puppeteer.launch({args: ['--no-sandbox']});
  }
  catch(e) {
    console.error(e);
    log(`Failed to launch puppeteer`);
  }

  log(`${id}: Browser started for ${url}`);

  lighthouseFlags = lighthouseFlags || {};

  lighthouseFlags.port = (new URL(browser.wsEndpoint())).port;

  async function launch() {
    try
    {
      const lhr = await lighthouse(url, lighthouseFlags);
      log(`${id}: Lighthouse done for ${url}`);
    }
    catch(e) {
      console.error(e);
      log(`Failed to start lighthouse`);
    }
    return lhr;
  }

  try {
    log(`${id}: Starting lighthouse for ${url}`);
    log(lighthouseFlags);
    return await launch();
  } catch (e) {
    log(`${id}: Retrying lighthouse for ${url}`);
    return await launch();
  } finally {
    await browser.close();
    log(`${id}: Browser closed for ${url}`);
  }
}

/**
 * Parse the Lighthouse report into an object format corresponding to the BigQuery schema.
 *
 * @param {object} obj The lhr object.
 * @param {string} id ID of the source.
 * @returns {object} The parsed lhr object corresponding to the BigQuery schema.
 */
function createJSON(obj, id) {
  return {
    fetch_time: obj.fetchTime,
    site_url: obj.finalUrl,
    site_id: id,
    user_agent: obj.userAgent,
    emulated_as: obj.configSettings.emulatedFormFactor,
    blocked_urls: obj.configSettings.blockedUrlPatterns || [],
    accessibility: [{
      total_score: obj.categories.accessibility.score,
      bypass_repetitive_content: obj.audits.bypass.score === 1,
      color_contrast: obj.audits['color-contrast'].score === 1,
      document_title_found: obj.audits['document-title'].score === 1,
      no_duplicate_id_attribute: obj.audits['duplicate-id'].score === 1,
      html_has_lang_attribute: obj.audits['html-has-lang'].score === 1,
      html_lang_is_valid: obj.audits['html-lang-valid'].score === 1,
      images_have_alt_attribute: obj.audits['image-alt'].score === 1,
      form_elements_have_labels: obj.audits.label.score === 1,
      links_have_names: obj.audits['link-name'].score === 1,
      lists_are_well_formed: obj.audits.list.score === 1,
      list_items_within_proper_parents: obj.audits['listitem'].score === 1,
      meta_viewport_allows_zoom: obj.audits['meta-viewport'].score === 1
    }],
    best_practices: [{
      total_score: obj.categories['best-practices'].score,
      avoid_application_cache: obj.audits['appcache-manifest'].score === 1,
      uses_https: obj.audits['is-on-https'].score === 1,
      uses_http2: obj.audits['uses-http2'].score === 1,
      uses_passive_event_listeners: obj.audits['uses-passive-event-listeners'].score === 1,
      no_document_write: obj.audits['no-document-write'].score === 1,
      external_anchors_use_rel_noopener: obj.audits['external-anchors-use-rel-noopener'].score === 1,
      no_geolocation_on_start: obj.audits['geolocation-on-start'].score === 1,
      doctype_defined: obj.audits.doctype.score === 1,
      no_vulnerable_libraries: obj.audits['no-vulnerable-libraries'].score === 1,
      notification_asked_on_start: obj.audits['notification-on-start'].score === 1,
      avoid_deprecated_apis: obj.audits.deprecations.score === 1,
      allow_paste_to_password_field: obj.audits['password-inputs-can-be-pasted-into'].score === 1,
      errors_in_console: obj.audits['errors-in-console'].score === 1,
      images_have_correct_aspect_ratio: obj.audits['image-aspect-ratio'].score === 1
    }],
    performance: [{
      total_score: obj.categories.performance.score,
      first_contentful_paint: [{
        raw_value: obj.audits['first-contentful-paint'].rawValue,
        score: obj.audits['first-contentful-paint'].score
      }],
      first_meaningful_paint: [{
        raw_value: obj.audits['first-meaningful-paint'].rawValue,
        score: obj.audits['first-meaningful-paint'].score
      }],
      speed_index: [{
        raw_value: obj.audits['speed-index'].rawValue,
        score: obj.audits['speed-index'].score
      }],
      page_interactive: [{
        raw_value: obj.audits.interactive.rawValue,
        score: obj.audits.interactive.score
      }],
      first_cpu_idle: [{
        raw_value: obj.audits['first-cpu-idle'].rawValue,
        score: obj.audits['first-cpu-idle'].score
      }]
    }],
    pwa: [{
      total_score: obj.categories.pwa.score,
      load_fast_enough: obj.audits['load-fast-enough-for-pwa'].score === 1,
      works_offline: obj.audits['works-offline'].score === 1,
      installable_manifest: obj.audits['installable-manifest'].score === 1,
      uses_https: obj.audits['is-on-https'].score === 1,
      redirects_http_to_https: obj.audits['redirects-http'].score === 1,
      has_meta_viewport: obj.audits.viewport.score === 1,
      uses_service_worker: obj.audits['service-worker'].score === 1,
      works_without_javascript: obj.audits['without-javascript'].score === 1,
      splash_screen_found: obj.audits['splash-screen'].score === 1,
      themed_address_bar: obj.audits['themed-omnibox'].score === 1
    }],
    seo: [{
      total_score: obj.categories.seo.score,
      has_meta_viewport: obj.audits.viewport.score === 1,
      document_title_found: obj.audits['document-title'].score === 1,
      meta_description: obj.audits['meta-description'].score === 1,
      http_status_code: obj.audits['http-status-code'].score === 1,
      descriptive_link_text: obj.audits['link-text'].score === 1,
      is_crawlable: obj.audits['is-crawlable'].score === 1,
      robots_txt_valid: obj.audits['robots-txt'].score === 1,
      hreflang_valid: obj.audits.hreflang.score === 1,
      font_size_ok: obj.audits['font-size'].score === 1,
      plugins_ok: obj.audits.plugins.score === 1
    }]
  }
}

/**
 * Converts input object to newline-delimited JSON
 *
 * @param {object} data Object to convert.
 * @returns {string} The stringified object.
 */
function toNdjson(data) {
  data = Array.isArray(data) ? data : [data];
  let outNdjson = '';
  data.forEach(item => {
    outNdjson += JSON.stringify(item) + '\n';
  });
  return outNdjson;
}

async function sendToPubsub(msg) {
  log(`Pubsub sending message: ${msg}`);
  const buffer = Buffer.from(msg);
  try {
    await pubsub
      .topic(process.env.PUBSUB_TOPIC || config.pubsubTopicId)
      .publisher()
      .publish(buffer);
    log(`Pubsub sent: ${msg}`);
  }
  catch(e) {
    console.error(e);
    log(`Failed to sent Pubsub msg: ${msg}`);
  }

}

/**
 * Publishes a message to the Pub/Sub topic for every ID in config.json source object.
 *
 * @param {array<string>} ids Array of ids to publish into Pub/Sub.
 * @returns {Promise<any[]>} Resolved promise when all IDs have been published.
 */
async function sendAllPubsubMsgs(ids) {
  const executionId = uuidv1();
  return await Promise.all(ids.map(async (id) => {
    log(`Processing: ${id}`)
    await sendToPubsub(`${id}${separator}${thirdPartyIncluded}${separator}mobile${separator}${executionId}`);
    await sendToPubsub(`${id}${separator}${thirdPartyIncluded}${separator}desktop${separator}${executionId}`);
    if (process.env.THIRDPARTY_TO_BLOCK) {
      await sendToPubsub(`${id}${separator}${thirdPartyBlocked}${separator}mobile${separator}${executionId}`);
      await sendToPubsub(`${id}${separator}${thirdPartyBlocked}${separator}desktop${separator}${executionId}`);
    }
  }));
}

/**
 * Write the lhr log object and reports to GCS. Only write reports if lighthouseFlags.output is defined in config.json.
 *
 * @param {object} obj The lighthouse audit object.
 * @param {string} id ID of the source.
 * @returns {Promise<void>} Resolved promise when all write operations are complete.
 */
async function writeLogAndReportsToStorage(obj, id) {
  const bucketName = process.env.BUCKET_NAME || config.gcs.bucketName;
  const bucket = storage.bucket(bucketName);
  config.lighthouseFlags.output = config.lighthouseFlags.output || [];
  await Promise.all(config.lighthouseFlags.output.map(async (fileType, idx) => {
    let filePath = `${id}/report_${obj.lhr.fetchTime}`;
    let mimetype;
    switch (fileType) {
      case 'csv':
        mimetype = 'text/csv';
        filePath += '.csv';
        break;
      case 'json':
        mimetype = 'application/json';
        filePath += '.json';
        break;
      default:
        filePath += '.html';
        mimetype = 'text/html';
    }
    const file = bucket.file(filePath);
    log(`${id}: Writing ${fileType} report to bucket ${bucketName}`);
    return await file.save(obj.report[idx], {
      metadata: {contentType: mimetype}
    });
  }));
  const file = bucket.file(`${id}/log_${obj.lhr.fetchTime}.json`);
  log(`${id}: Writing log to bucket ${bucketName}`);
  return await file.save(JSON.stringify(obj.lhr, null, " "), {
    metadata: {contentType: 'application/json'}
  });
}

/**
 * Check events in GCS states.json to see if an event with given ID has been pushed to Pub/Sub less than
 * minTimeBetweenTriggers (in config.json) ago.
 *
 * @param {string} id ID of the source (and the Pub/Sub message).
 * @param {number} timeNow Timestamp when this method was invoked.
 * @returns {Promise<object>} Object describing active state and time delta between invocation and when the state entry was created, if necessary.
 */
async function checkEventState(id, timeNow) {
  const bucketName = process.env.BUCKET_NAME || config.gcs.bucketName;
  let eventStates = {};
  try {
    // Try to load existing state file from storage
    const destination = `/tmp/state_${id}.json`;
    await storage
      .bucket(bucketName)
      .file(`${id}/state.json`)
      .download({destination: destination});
    eventStates = JSON.parse(await readFile(destination));
  } catch(e) {
    console.error(e);
  }

  // Check if event corresponding to id has been triggered less than the timeout ago
  const delta = id in eventStates && (timeNow - eventStates[id].created);
  if (delta && delta < config.minTimeBetweenTriggers) {
    return {active: true, delta: Math.round(delta/1000)}
  }

  // Otherwise write the state of the event with current timestamp and save to bucket
  eventStates[id] = {created: timeNow};
  await storage.bucket(bucketName).file(`${id}/state.json`).save(JSON.stringify(eventStates, null, " "), {
    metadata: {contentType: 'application/json'}
  });
  return {active: false}
}

/**
 * The Cloud Function. Triggers on a Pub/Sub trigger, audits the URLs in config.json, writes the result in GCS and loads the data into BigQuery.
 *
 * @param {object} event Trigger object.
 * @param {function} callback Callback function (not provided).
 * @returns {Promise<*>} Promise when BigQuery load starts.
 */
async function launchLighthouse (event, callback) {

    let source = config.source;
    const sourceUrl = process.env.SOURCE_URL;
    const sourceAuth = process.env.SOURCE_AUTH;
    if (sourceUrl) {

      const headers = { };
      if (sourceAuth) {
        headers.Authorization = sourceAuth;
      }
      try {
        const externalSource = await requestGet({uri: sourceUrl, headers: headers});
      }
      catch(e) {
        console.error(e);
        log(`Request GET`);
      }
      source = flatContentfulJson(externalSource)
      if (process.env.EXTRA_URLS) {
        const extras = process.env.EXTRA_URLS.split(',').map(extraUrl => {
          const extraUrlParts = extraUrl.split('::');
          if (extraUrlParts[0] && extraUrlParts[1]) {
            return {
              'id': extraUrlParts[0],
              'url': extraUrlParts[1]
            }
          }
        }).filter(Boolean)
        source.push(...extras);
      }
    }

    const msg = "Buffer.from(event.data, 'base64').toString()";
    const msgParts = msg.split(separator);
    const idMsg = msgParts[0];
    const lighthouseFlags = {...config.lighthouseFlags};
    if (msgParts[1] === thirdPartyBlocked) {
      lighthouseFlags.blockedUrlPatterns = process.env.THIRDPARTY_TO_BLOCK.split(',');
    }
    if (msgParts[2]) {
      lighthouseFlags.emulatedFormFactor = msgParts[2];
    }

    const ids = source.map(obj => obj.id);
    const uuid = uuidv1();
    // const metadata = {
    //   sourceFormat: 'NEWLINE_DELIMITED_JSON',
    //   schema: {fields: bqSchema},
    //   jobId: uuid
    // };

    // If the Pub/Sub message is not valid
    if (idMsg !== 'all' && !ids.includes(idMsg)) { return console.error('No valid message found!'); }

    if (idMsg === 'all') {
      return sendAllPubsubMsgs(ids);
    }

    const [src] = source.filter(obj => obj.id === idMsg);
    const id = src.id;
    const url = src.url;
    const executionId = msgParts[3] || 'no_execution_id';

    log(`${msg}: Received message to start with URL ${url}, third party ${msgParts[1]}, mode ${msgParts[2]}, executionId: ${executionId}`);

    const timeNow = new Date().getTime();

    try
    {
    const eventState = await checkEventState(msg, timeNow);
    }
    catch(e) {
      console.error(e);
      log(`Failed to check eventsState`);
    }


    if (eventState.active) {
      return log(`${msg}: Found active event (${Math.round(eventState.delta)}s < ${Math.round(config.minTimeBetweenTriggers/1000)}s), aborting...`);
    }
    try
    {
      const res = await launchBrowserWithLighthouse(id, url, lighthouseFlags);
    }
    catch(e) {
      console.error(e);
      log(`Configuration validated successfully`);
    }

    try
    {
      await writeLogAndReportsToStorage(res, msg);
    }
    catch(e) {
      console.error(e);
      log(`Configuration validated successfully`);
    }

    const json = createJSON(res.lhr, id);

    json.job_id = uuid;
    json.execution_id = executionId;

    // await writeFile(`/tmp/${uuid}.json`, toNdjson(json));

    log(`${id}: BigQuery job with ID ${uuid} starting for ${url}`);;


    const dataset = bigquery.dataset(process.env.DATASET_ID || config.datasetId);
    try
    {
      const tableExists = await dataset.table('reports').exists();
    }
    catch(e) {
      console.error(e);
      log(`Failed to check if table exists`);
    }

    if (!tableExists[0]) {
      const options = {
        schema: bqSchema
      };
      try
      {
        await dataset
        .createTable('reports', options);
      }
      catch(e) {
        console.error(e);
        log(`Failed to create table`);
      }
    }

    try {
      await dataset
      .table('reports')
      .insert({id: uuid, json: json}, {raw: true});

      log(`${id}: BigQuery job with ID ${uuid} finished  for ${url}`);
    } catch(err) {
      log('Error on insert of bigquery')
      log(JSON.stringify(err))
    }

}

function flatContentfulJson(json) {
  const fields = JSON.parse(json.body).fields;
  const sections = ['help', 'fmcTariffs', 'mobileTariffs', 'mobilePhones', 'fixedTariffs', 'prepaidTariffs', 'other', 'bussiness', 'privateZone', 'fullWeb'];
  const sourceArray = [];
  sections.forEach(section => {
    if (fields.json[section]) {
      sourceArray.push({url: fields.json[section]['url'], id: fields.json[section]['name']})
      fields.json[section]['list'].forEach(entry => {
          sourceArray.push({url: entry.url, id: entry.name})
          if (entry.list) {
            entry.list.forEach(subEntry => {
              sourceArray.push({url: subEntry.url, id: subEntry.name})
            })
        }
      })
    }
  })
  return sourceArray;
}

/**
 * Initialization function - only run when Cloud Function is deployed and/or a new instance is started. Validates the configuration file against its schema.
 */
function init() {
  // Validate config schema
  const result = validator.validate(config, configSchema);
  if (result.errors.length) {
    throw new Error(`Error(s) in configuration file: ${JSON.stringify(result.errors, null, " ")}`);
  } else {
    log(`Configuration validated successfully`);
  }
}

if (process.env.NODE_ENV !== 'test') {
  init();
} else {
  // For testing
  module.exports = {
    _init: init,
    _writeLogAndReportsToStorage: writeLogAndReportsToStorage,
    _sendAllPubSubMsgs: sendAllPubsubMsgs,
    _toNdJson: toNdjson,
    _createJSON: createJSON,
    _launchBrowserWithLighthouse: launchBrowserWithLighthouse,
    _checkEventState: checkEventState
  }
}

module.exports.launchLighthouse = launchLighthouse;
