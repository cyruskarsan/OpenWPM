import { HttpPostParser, ParsedPostRequest } from "../lib/http-post-parser";
import { PendingRequest } from "../lib/pending-request";
import { PendingResponse } from "../lib/pending-response";
import ResourceType = browser.webRequest.ResourceType;
import BlockingResponse = browser.webRequest.BlockingResponse;
import { boolToInt, escapeString } from "../lib/string-utils";
import {
  WebRequestOnBeforeRedirectEventDetails,
  WebRequestOnBeforeRequestEventDetails,
  WebRequestOnBeforeSendHeadersEventDetails,
  WebRequestOnCompletedEventDetails,
} from "../types/browser-web-reqest-event-details";
import { HttpRedirect, HttpRequest, HttpResponse } from "../types/schema";

/**
 * Note: Different parts of the desired information arrives in different events as per below:
 * request = headers in onBeforeSendHeaders + body in onBeforeRequest
 * response = headers in onCompleted + body via a onBeforeRequest filter
 * redirect = original request headers+body, followed by a onBeforeRedirect and then a new set of request headers+body and response headers+body
 * Docs: https://developer.mozilla.org/en-US/docs/User:wbamberg/webRequest.RequestDetails
 */

export class HttpInstrument {
  private readonly dataReceiver;
  private pendingRequests: {
    [requestId: number]: PendingRequest;
  } = {};
  private pendingResponses: {
    [requestId: number]: PendingResponse;
  } = {};

  constructor(dataReceiver) {
    this.dataReceiver = dataReceiver;
  }

  public run(crawlID, saveJavascript, saveAllContent) {
    const allTypes: ResourceType[] = [
      "beacon",
      "csp_report",
      "font",
      "image",
      "imageset",
      "main_frame",
      "media",
      "object",
      "object_subrequest",
      "ping",
      "script",
      // "speculative",
      "stylesheet",
      "sub_frame",
      "web_manifest",
      "websocket",
      "xbl",
      "xml_dtd",
      "xmlhttprequest",
      "xslt",
      "other",
    ];

    const requestStemsFromExtension = details => {
      return (
        details.originUrl && details.originUrl.indexOf("moz-extension://") > -1
      );
    };

    /*
     * Attach handlers to event listeners
     */

    browser.webRequest.onBeforeRequest.addListener(
      details => {
        const blockingResponseThatDoesNothing: BlockingResponse = {};
        // Ignore requests made by extensions
        if (requestStemsFromExtension(details)) {
          return blockingResponseThatDoesNothing;
        }
        const pendingRequest = this.getPendingRequest(details.requestId);
        pendingRequest.resolveBeforeRequestEventDetails(details);
        const pendingResponse = this.getPendingResponse(details.requestId);
        pendingResponse.resolveBeforeRequestEventDetails(details);
        if (saveAllContent) {
          pendingResponse.addResponseResponseBodyListener(details);
        } else if (
          saveJavascript &&
          this.mayYieldAJSResponse(details.type, details.url)
        ) {
          pendingResponse.addResponseResponseBodyListener(details);
        }
        return blockingResponseThatDoesNothing;
      },
      { urls: ["http://*/*", "https://*/*"], types: allTypes },
      saveJavascript || saveAllContent
        ? ["requestBody", "blocking"]
        : ["requestBody"],
    );

    browser.webRequest.onBeforeSendHeaders.addListener(
      details => {
        // Ignore requests made by extensions
        if (requestStemsFromExtension(details)) {
          return;
        }
        const pendingRequest = this.getPendingRequest(details.requestId);
        pendingRequest.resolveOnBeforeSendHeadersEventDetails(details);
        this.onBeforeSendHeadersHandler(details, crawlID);
      },
      { urls: ["http://*/*", "https://*/*"], types: allTypes },
      ["requestHeaders"],
    );

    browser.webRequest.onBeforeRedirect.addListener(
      details => {
        // Ignore requests made by extensions
        if (requestStemsFromExtension(details)) {
          return;
        }
        this.onBeforeRedirectHandler(details, crawlID);
      },
      { urls: ["http://*/*", "https://*/*"], types: allTypes },
      ["responseHeaders"],
    );

    browser.webRequest.onCompleted.addListener(
      details => {
        // Ignore requests made by extensions
        if (requestStemsFromExtension(details)) {
          return;
        }
        const pendingResponse = this.getPendingResponse(details.requestId);
        pendingResponse.resolveOnCompletedEventDetails(details);
        this.onCompletedHandler(
          details,
          crawlID,
          saveJavascript,
          saveAllContent,
        );
      },
      { urls: ["http://*/*", "https://*/*"], types: allTypes },
      ["responseHeaders"],
    );
  }

  private getPendingRequest(requestId) {
    if (!this.pendingRequests[requestId]) {
      this.pendingRequests[requestId] = new PendingRequest();
    }
    return this.pendingRequests[requestId];
  }

  private getPendingResponse(requestId) {
    if (!this.pendingResponses[requestId]) {
      this.pendingResponses[requestId] = new PendingResponse();
    }
    return this.pendingResponses[requestId];
  }

  /*
   * HTTP Request Handler and Helper Functions
   */

  /*
  // TODO: Refactor to corresponding webext logic or discard
  private get_stack_trace_str() {
    // return the stack trace as a string
    // TODO: check if http-on-modify-request is a good place to capture the stack
    // In the manual tests we could capture exactly the same trace as the
    // "Cause" column of the devtools network panel.
    const stacktrace = [];
    let frame = components.stack;
    if (frame && frame.caller) {
      // internal/chrome callers occupy the first three frames, pop them!
      frame = frame.caller.caller.caller;
      while (frame) {
        // chrome scripts appear as callers in some cases, filter them out
        const scheme = frame.filename.split("://")[0];
        if (["resource", "chrome", "file"].indexOf(scheme) === -1) {
          // ignore chrome scripts
          stacktrace.push(
            frame.name +
              "@" +
              frame.filename +
              ":" +
              frame.lineNumber +
              ":" +
              frame.columnNumber +
              ";" +
              frame.asyncCause,
          );
        }
        frame = frame.caller || frame.asyncCaller;
      }
    }
    return stacktrace.join("\n");
  }
  */

  private async onBeforeSendHeadersHandler(
    details: WebRequestOnBeforeSendHeadersEventDetails,
    crawlID,
  ) {
    /*
    console.log(
      "onBeforeSendHeadersHandler (previously httpRequestHandler)",
      details,
      crawlID,
    );
    */

    // http_requests table schema:
    // id [auto-filled], crawl_id, url, method, referrer,
    // headers, visit_id [auto-filled], time_stamp
    const update = {} as HttpRequest;

    update.crawl_id = crawlID;

    // requestId is a unique identifier that can be used to link requests and responses
    update.channel_id = details.requestId;

    // const stacktrace_str = get_stack_trace_str();
    // update.req_call_stack = escapeString(stacktrace_str);

    const url = details.url;
    update.url = escapeString(url);

    const requestMethod = details.method;
    update.method = escapeString(requestMethod);

    // TODO: Refactor to corresponding webext logic or discard
    // let referrer = "";
    // if (details.referrer) {
    //   referrer = details.referrer.spec;
    // }
    // update.referrer = escapeString(referrer);

    const current_time = new Date(details.timeStamp);
    update.time_stamp = current_time.toISOString();

    let encodingType = "";
    const headers = [];
    let isOcsp = false;
    details.requestHeaders.map(requestHeader => {
      const { name, value } = requestHeader;
      const header_pair = [];
      header_pair.push(escapeString(name));
      header_pair.push(escapeString(value));
      headers.push(header_pair);
      if (name === "Content-Type") {
        encodingType = value;
        if (encodingType.indexOf("application/ocsp-request") !== -1) {
          isOcsp = true;
        }
      }
    });

    if (requestMethod === "POST" && !isOcsp /* don't process OCSP requests */) {
      const pendingRequest = this.getPendingRequest(details.requestId);
      const resolved = await pendingRequest.resolvedWithinTimeout(1000);
      if (!resolved) {
        this.dataReceiver.logError(
          "Pending request timed out waiting for data from both onBeforeRequest and onBeforeSendHeaders events",
        );
      } else {
        const onBeforeRequestEventDetails = await pendingRequest.onBeforeRequestEventDetails;
        const requestBody = onBeforeRequestEventDetails.requestBody;

        if (requestBody) {
          const postParser = new HttpPostParser(
            // details,
            onBeforeRequestEventDetails,
            this.dataReceiver,
          );
          const postObj: ParsedPostRequest = postParser.parsePostRequest(
            encodingType,
          );

          // Add (POST) request headers from upload stream
          if ("post_headers" in postObj) {
            // Only store POST headers that we know and need. We may misinterpret POST data as headers
            // as detection is based on "key:value" format (non-header POST data can be in this format as well)
            const contentHeaders = [
              "Content-Type",
              "Content-Disposition",
              "Content-Length",
            ];
            for (const name in postObj.post_headers) {
              if (contentHeaders.includes(name)) {
                const header_pair = [];
                header_pair.push(escapeString(name));
                header_pair.push(escapeString(postObj.post_headers[name]));
                headers.push(header_pair);
              }
            }
          }
          // we store POST body in JSON format, except when it's a string without a (key-value) structure
          if ("post_body" in postObj) {
            update.post_body = postObj.post_body;
          }
        }
      }
    }

    update.headers = JSON.stringify(headers);

    // Check if xhr
    const isXHR = details.type === "xmlhttprequest";
    update.is_XHR = boolToInt(isXHR);

    // Check if frame OR full page load
    const isFullPageLoad = details.frameId === 0;
    const isFrameLoad = details.type === "sub_frame";
    update.is_full_page = boolToInt(isFullPageLoad);
    update.is_frame_load = boolToInt(isFrameLoad);

    /*
    // Grab the triggering and loading Principals
    // TODO: Refactor to corresponding webext logic or discard
    let triggeringOrigin;
    let loadingOrigin;
    if (details.loadInfo.triggeringPrincipal) {
      triggeringOrigin = details.loadInfo.triggeringPrincipal.origin;
    }
    if (details.loadInfo.loadingPrincipal) {
      loadingOrigin = details.loadInfo.loadingPrincipal.origin;
    }
    update.triggering_origin = escapeString(triggeringOrigin);
    update.loading_origin = escapeString(loadingOrigin);
    */

    // loadingDocument's href
    // The loadingDocument is the document the element resides, regardless of
    // how the load was triggered.
    const loadingHref = details.documentUrl;
    update.loading_href = escapeString(loadingHref);

    // resourceType of the requesting node. This is set by the type of
    // node making the request (i.e. an <img src=...> node will set to type "image").
    // Documentation:
    // https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/ResourceType
    update.resource_type = details.type;

    /*
    // TODO: Refactor to corresponding webext logic or discard
    const ThirdPartyUtil = Cc["@mozilla.org/thirdpartyutil;1"].getService(
                           Ci.mozIThirdPartyUtil);
    // Do third-party checks
    // These specific checks are done because it's what's used in Tracking Protection
    // See: http://searchfox.org/mozilla-central/source/netwerk/base/nsChannelClassifier.cpp#107
    try {
      const isThirdPartyChannel = ThirdPartyUtil.isThirdPartyChannel(details);
      const topWindow = ThirdPartyUtil.getTopWindowForChannel(details);
      const topURI = ThirdPartyUtil.getURIFromWindow(topWindow);
      if (topURI) {
        const topUrl = topURI.spec;
        const channelURI = details.URI;
        const isThirdPartyToTopWindow = ThirdPartyUtil.isThirdPartyURI(
          channelURI,
          topURI,
        );
        update.is_third_party_to_top_window = isThirdPartyToTopWindow;
        update.is_third_party_channel = isThirdPartyChannel;
        update.top_level_url = escapeString(topUrl);
      }
    } catch (anError) {
      // Exceptions expected for channels triggered or loading in a
      // NullPrincipal or SystemPrincipal. They are also expected for favicon
      // loads, which we attempt to filter. Depending on the naming, some favicons
      // may continue to lead to error logs.
      if (
        update.triggering_origin !== "[System Principal]" &&
        update.triggering_origin !== undefined &&
        update.loading_origin !== "[System Principal]" &&
        update.loading_origin !== undefined &&
        !update.url.endsWith("ico")
      ) {
        this.dataReceiver.logError(
          "Error while retrieving additional channel information for URL: " +
          "\n" +
          update.url +
          "\n Error text:" +
          JSON.stringify(anError),
        );
      }
    }
    */

    this.dataReceiver.saveRecord("http_requests", update);
  }

  private onBeforeRedirectHandler(
    details: WebRequestOnBeforeRedirectEventDetails,
    crawlID,
  ) {
    /*
    console.log(
      "onBeforeRedirectHandler (previously httpRequestHandler)",
      details,
      crawlID,
    );
    */

    // Save HTTP redirect events
    // Events are saved to the `http_redirects` table

    /*
    // TODO: Refactor to corresponding webext logic or discard
    // Events are saved to the `http_redirects` table, and map the old
    // request/response channel id to the new request/response channel id.
    // Implementation based on: https://stackoverflow.com/a/11240627
    const oldNotifications = details.notificationCallbacks;
    let oldEventSink = null;
    details.notificationCallbacks = {
      QueryInterface: XPCOMUtils.generateQI([
        Ci.nsIInterfaceRequestor,
        Ci.nsIChannelEventSink,
      ]),

      getInterface(iid) {
        // We are only interested in nsIChannelEventSink,
        // return the old callbacks for any other interface requests.
        if (iid.equals(Ci.nsIChannelEventSink)) {
          try {
            oldEventSink = oldNotifications.QueryInterface(iid);
          } catch (anError) {
            this.dataReceiver.logError(
              "Error during call to custom notificationCallbacks::getInterface." +
                JSON.stringify(anError),
            );
          }
          return this;
        }

        if (oldNotifications) {
          return oldNotifications.getInterface(iid);
        } else {
          throw Cr.NS_ERROR_NO_INTERFACE;
        }
      },

      asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
        const isTemporary = !!(flags & Ci.nsIChannelEventSink.REDIRECT_TEMPORARY);
        const isPermanent = !!(flags & Ci.nsIChannelEventSink.REDIRECT_PERMANENT);
        const isInternal = !!(flags & Ci.nsIChannelEventSink.REDIRECT_INTERNAL);
        const isSTSUpgrade = !!(
          flags & Ci.nsIChannelEventSink.REDIRECT_STS_UPGRADE
        );

        newChannel.QueryInterface(Ci.nsIHttpChannel);

        const httpRedirect: HttpRedirect = {
          crawl_id: crawlID,
          old_channel_id: oldChannel.channelId,
          new_channel_id: newChannel.channelId,
          is_temporary: isTemporary,
          is_permanent: isPermanent,
          is_internal: isInternal,
          is_sts_upgrade: isSTSUpgrade,
          time_stamp: new Date().toISOString(),
        };
        this.dataReceiver.saveRecord("http_redirects", httpRedirect);

        if (oldEventSink) {
          oldEventSink.asyncOnChannelRedirect(
            oldChannel,
            newChannel,
            flags,
            callback,
          );
        } else {
          callback.onRedirectVerifyCallback(Cr.NS_OK);
        }
      },
    };
    */

    const httpRedirect: HttpRedirect = {
      crawl_id: crawlID,
      old_channel_id: null, // previously: oldChannel.channelId, TODO: Refactor to corresponding webext logic or discard
      new_channel_id: details.requestId, // previously: newChannel.channelId, TODO: Refactor to corresponding webext logic or discard
      is_temporary: null, // TODO: Refactor to corresponding webext logic or discard
      is_permanent: null, // TODO: Refactor to corresponding webext logic or discard
      is_internal: null, // TODO: Refactor to corresponding webext logic or discard
      is_sts_upgrade: null, // TODO: Refactor to corresponding webext logic or discard
      time_stamp: new Date(details.timeStamp).toISOString(),
    };

    this.dataReceiver.saveRecord("http_redirects", httpRedirect);
  }

  /*
  * HTTP Response Handlers and Helper Functions
  */

  private async logWithResponseBody(
    details: WebRequestOnBeforeRequestEventDetails,
    update,
  ) {
    const pendingResponse = this.getPendingResponse(details.requestId);
    try {
      const responseBodyListener = pendingResponse.responseBodyListener;
      const respBody = await responseBodyListener.getResponseBody();
      const contentHash = await responseBodyListener.getContentHash();
      this.dataReceiver.saveContent(
        escapeString(respBody),
        escapeString(contentHash),
      );
      this.dataReceiver.saveRecord("http_responses", update);
    } catch (err) {
      /*
      // TODO: Refactor to corresponding webext logic or discard
      dataReceiver.logError(
        "Unable to retrieve response body." + JSON.stringify(aReason),
      );
      update.content_hash = "<error>";
      dataReceiver.saveRecord("http_responses", update);
      */
      this.dataReceiver.logError(
        "Unable to retrieve response body." +
          "Likely caused by a programming error. Error Message:" +
          err.name +
          err.message +
          "\n" +
          err.stack,
      );
      update.content_hash = "<error>";
      this.dataReceiver.saveRecord("http_responses", update);
    }
  }

  /**
   * Return true if this request is loading javascript
   * We rely mostly on the content policy type to filter responses
   * and fall back to the URI and content type string for types that can
   * load various resource types.
   * See: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/ResourceType
   *
   * @param details
   * @param contentType
   */
  private isJS(resourceType: ResourceType, url: string, contentType): boolean {
    if (resourceType === "script") {
      return true;
    }
    if (
      resourceType !== "object" && // object
      resourceType !== "sub_frame" && // subdocument (iframe)
      resourceType !== "xmlhttprequest" && // XMLHTTPRequest
      resourceType !== "websocket" && // websocket
      resourceType !== "beacon" // beacon response
    ) {
      return false;
    }

    if (contentType && contentType.toLowerCase().includes("javascript")) {
      return true;
    }

    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    if (
      path &&
      path
        .split("?")[0]
        .split("#")[0]
        .endsWith(".js")
    ) {
      return true;
    }
    return false;
  }

  /**
   * Return true if this request is likely to load javascript
   * @param details
   * @param contentType
   */
  private mayYieldAJSResponse(
    resourceType: ResourceType,
    url: string,
  ): boolean {
    // We do not know the content type of the response yet, so
    // we can not use it to know if the response is JS or not
    const contentType = false;
    return this.isJS(resourceType, url, contentType);
  }

  // Instrument HTTP responses
  private onCompletedHandler(
    details: WebRequestOnCompletedEventDetails,
    crawlID,
    saveJavascript,
    saveAllContent,
  ) {
    /*
    console.log(
      "onCompletedHandler (previously httpRequestHandler)",
      details,
      crawlID,
      saveJavascript,
      saveAllContent,
    );
    */

    // http_responses table schema:
    // id [auto-filled], crawl_id, url, method, referrer, response_status,
    // response_status_text, headers, location, visit_id [auto-filled],
    // time_stamp, content_hash
    const update = {} as HttpResponse;

    update.crawl_id = crawlID;

    // requestId is a unique identifier that can be used to link requests and responses
    update.channel_id = details.requestId;

    const isCached = details.fromCache;
    update.is_cached = boolToInt(isCached);

    const url = details.url;
    update.url = escapeString(url);

    const requestMethod = details.method;
    update.method = escapeString(requestMethod);

    // TODO: Refactor to corresponding webext logic or discard
    // let referrer = "";
    // if (details.referrer) {
    //   referrer = details.referrer.spec;
    // }
    // update.referrer = escapeString(referrer);

    const responseStatus = details.statusCode;
    update.response_status = responseStatus;

    const responseStatusText = details.statusLine;
    update.response_status_text = escapeString(responseStatusText);

    const current_time = new Date(details.timeStamp);
    update.time_stamp = current_time.toISOString();

    const headers = [];
    let location = "";
    let contentType = "";
    details.responseHeaders.map(responseHeader => {
      const { name, value } = responseHeader;
      const header_pair = [];
      header_pair.push(escapeString(name));
      header_pair.push(escapeString(value));
      headers.push(header_pair);
      if (name.toLowerCase() === "location") {
        location = value;
      }
      if (name.toLowerCase() === "content-type") {
        contentType = value;
      }
    });
    update.headers = JSON.stringify(headers);
    update.location = escapeString(location);

    if (saveAllContent) {
      this.logWithResponseBody(details, update);
    } else if (
      saveJavascript &&
      this.isJS(details.type, details.url, contentType)
    ) {
      this.logWithResponseBody(details, update);
    } else {
      this.dataReceiver.saveRecord("http_responses", update);
    }
  }
}
