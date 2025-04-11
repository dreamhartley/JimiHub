const express = require('express');
const fetch = require('node-fetch');
const requireWorkerAuth = require('../middleware/workerAuth');
const geminiKeyService = require('../services/geminiKeyService');
const configService = require('../services/configService'); // Needed for model lookup for key selection

const router = express.Router();

// Apply worker authentication middleware to all /v1beta routes
router.use(requireWorkerAuth);

// --- Helper to get the effective base URL for Gemini API ---
function getGeminiBaseUrl() {
    const customGateway = process.env.CF_GATEWAY;
    const effectiveGatewayUrl = customGateway && customGateway.trim() !== '' ? customGateway.trim().replace(/\/$/, '') : null;
    const baseUrl = effectiveGatewayUrl || 'https://generativelanguage.googleapis.com';
    return baseUrl;
}

// Middleware to extract Worker API Key from query param if header is missing
const workerAuthFromQuery = (req, res, next) => {
    if (!req.headers.authorization && req.query.key) {
        // Found key in query param, treat it as Worker API Key for this request
        // Attach it for requireWorkerAuth middleware or direct use
        req.headers.authorization = `Bearer ${req.query.key}`;
        console.log('Using Worker API Key from query parameter.');
        // IMPORTANT: Remove the key from the query object so it's not forwarded
        delete req.query.key;
        // Reconstruct req.url without the key for subsequent middleware/routing
        const urlParts = req.url.split('?');
        const queryParams = new URLSearchParams(urlParts[1] || '');
        queryParams.delete('key');
        req.url = urlParts[0] + (queryParams.toString() ? `?${queryParams.toString()}` : '');
    }
    next();
};

// Apply query param auth check *before* the standard worker auth
router.use(workerAuthFromQuery);
router.use(requireWorkerAuth); // Now this can validate header even if it came from query

// --- Catch-all handler for /v1beta/* ---
router.all('*', async (req, res, next) => {
    const workerApiKey = req.workerApiKey; // Now correctly populated even from query
    // Extract the path *after* /v1beta/
    let subPath = req.path;
    // Find the actual Gemini API path (e.g., /models, /files) after potential extra segments
    const geminiPathMatch = subPath.match(/(\/models\/|\/files\/|\/operations\/|\/tunedModels\/|\/permission\/).*/);
    const actualGeminiPath = geminiPathMatch ? geminiPathMatch[0] : subPath; // Fallback to subPath if pattern not found

    // Get the original query string (already modified by workerAuthFromQuery if key was present)
    const originalQuery = req.url.split('?')[1] || '';
    const method = req.method;
    const requestBody = req.body; // Assumes express.json() is used

    console.log(`Received /v1beta request. Worker Key: ${workerApiKey ? 'OK' : 'Not Found/Invalid'}. Original SubPath: ${subPath}. Detected Gemini Path: ${actualGeminiPath}`);

    console.log(`Received /v1beta request: ${method} ${originalPath}`);

    try {
        // --- 1. Extract Model ID for Key Selection ---
        // Attempt to extract model from path like /models/gemini-pro:action
        // Attempt to extract model from the *actual* Gemini path
        const modelMatch = actualGeminiPath.match(/^\/models\/([^:]+):/);
        const modelId = modelMatch ? modelMatch[1] : null;

        if (!modelId) {
            console.warn(`Could not extract modelId from normalized path: ${normalizedPath} (original client path: ${clientPath}) for key selection.`);
            // Proceed without modelId for key selection if necessary, or return error?
            // For now, let's proceed, getNextAvailableGeminiKey might handle null modelId
        }

        // --- 2. Get Rotated Gemini API Key ---
        const modelsConfig = await configService.getModelsConfig(); // Fetch config for category lookup
        const modelCategory = modelId ? modelsConfig[modelId]?.category : null;
        const selectedKey = await geminiKeyService.getNextAvailableGeminiKey(modelId); // Pass modelId if found

        if (!selectedKey) {
            return res.status(503).json({ error: { message: "No available Gemini API Key configured or all keys are currently rate-limited/invalid.", type: "no_key_available" } });
        }

        // --- 3. Construct Target Gemini URL ---
        const baseGeminiUrl = getGeminiBaseUrl();
        // Append the *actual detected* Gemini path and the (potentially modified) query string
        const targetUrl = `${baseGeminiUrl}${actualGeminiPath}${originalQuery ? '?' + originalQuery : ''}`;

        console.log(`Proxying to target URL: ${targetUrl} with key ID: ${selectedKey.id}`);

        // --- 4. Prepare Headers ---
        const headersToForward = { ...req.headers };
        // Remove headers specific to this proxy or potentially problematic
        delete headersToForward['host'];
        delete headersToForward['authorization']; // Remove original worker key auth (whether from header or query)
        delete headersToForward['connection'];
        // Add the Gemini API key
        headersToForward['x-goog-api-key'] = selectedKey.key;
        // Ensure content-type is present if there's a body
        if (method !== 'GET' && method !== 'HEAD' && !headersToForward['content-type']) {
            headersToForward['content-type'] = 'application/json'; // Default if missing
        }
        // Set a user-agent
        headersToForward['user-agent'] = 'gemini-proxy-panel-node/v1beta';

        // --- 5. Make the Proxied Request ---
        const geminiResponse = await fetch(targetUrl, {
            method: method,
            headers: headersToForward,
            // Only include body for relevant methods
            body: (method !== 'GET' && method !== 'HEAD' && requestBody) ? JSON.stringify(requestBody) : undefined,
            // Increase timeout if needed
            // timeout: 300000
        });

        // --- 6. Handle Response ---
        // Set headers from Gemini response to our response
        res.status(geminiResponse.status);
        geminiResponse.headers.forEach((value, name) => {
            // Avoid setting headers that cause issues (e.g., transfer-encoding with streams)
            if (name.toLowerCase() !== 'transfer-encoding' && name.toLowerCase() !== 'connection') {
                 // Skip content-encoding if it might interfere with Express/Node handling
                 if (name.toLowerCase() === 'content-encoding' && value === 'gzip') {
                    console.log("Skipping content-encoding: gzip header from upstream");
                 } else {
                    res.setHeader(name, value);
                 }
            }
        });
        // Add custom header
        res.setHeader('X-Proxied-By', 'gemini-proxy-panel-node/v1beta');
        res.setHeader('X-Selected-Key-ID', selectedKey.id);

        // Pipe the response body directly
        if (geminiResponse.body) {
            geminiResponse.body.pipe(res);
            // Increment usage after successfully starting the stream/response
            geminiKeyService.incrementKeyUsage(selectedKey.id, modelId, modelCategory)
                .catch(err => console.error(`Error incrementing usage for key ${selectedKey.id} in background:`, err));
            // Handle 429/401/403 based on status *after* sending headers
             if (!geminiResponse.ok) {
                 console.warn(`Gemini API returned non-OK status ${geminiResponse.status} for key ${selectedKey.id}`);
                 if (geminiResponse.status === 429) {
                     // Attempt to read body for error message (might fail if already piped)
                     try {
                         const errorBodyText = await geminiResponse.text(); // This might consume the stream
                         geminiKeyService.handle429Error(selectedKey.id, modelCategory, modelId, errorBodyText)
                             .catch(err => console.error(`Error handling 429 for key ${selectedKey.id} in background:`, err));
                     } catch (e) {
                         console.error("Could not read error body for 429 handling after piping started.");
                         geminiKeyService.handle429Error(selectedKey.id, modelCategory, modelId, "Unknown error (could not read body)")
                             .catch(err => console.error(`Error handling 429 for key ${selectedKey.id} in background:`, err));
                     }
                 } else if (geminiResponse.status === 401 || geminiResponse.status === 403) {
                     geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                         .catch(err => console.error(`Error recording key error ${geminiResponse.status} for key ${selectedKey.id} in background:`, err));
                 }
             }

        } else {
            res.end();
             // Increment usage even if no body
             geminiKeyService.incrementKeyUsage(selectedKey.id, modelId, modelCategory)
                .catch(err => console.error(`Error incrementing usage for key ${selectedKey.id} in background:`, err));
             // Handle non-OK status if no body
             if (!geminiResponse.ok) {
                 console.warn(`Gemini API returned non-OK status ${geminiResponse.status} (no body) for key ${selectedKey.id}`);
                 if (geminiResponse.status === 401 || geminiResponse.status === 403) {
                     geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                         .catch(err => console.error(`Error recording key error ${geminiResponse.status} for key ${selectedKey.id} in background:`, err));
                 }
                 // Handle 429? Less likely without a body, but possible.
             }
        }

    } catch (error) {
        console.error("Error in /v1beta proxy handler:", error);
        // Avoid sending error details if headers already sent
        if (!res.headersSent) {
            next(error); // Pass to global error handler
        } else {
            console.error("Headers already sent, cannot forward error to client.");
            res.end(); // End the response if possible
        }
    }
});

module.exports = router;