const express = require('express');
const requireAdminAuth = require('../middleware/adminAuth');
const configService = require('../services/configService');
const geminiKeyService = require('../services/geminiKeyService');
const fetch = require('node-fetch'); 
const { syncToGitHub } = require('../db'); 
const router = express.Router();

// Apply admin authentication middleware to all /api/admin routes
router.use(requireAdminAuth);

// --- Helper for parsing request body (already exists in helpers.js, but useful here) ---
// Ensure express.json() middleware is applied in server.js
function parseBody(req) {
    if (!req.body) {
        throw new Error("Request body not parsed. Ensure express.json() middleware is used.");
    }
    return req.body;
}

// --- Gemini Key Management --- (/api/admin/gemini-keys)
router.route('/gemini-keys')
    .get(async (req, res, next) => {
        try {
            const keys = await geminiKeyService.getAllGeminiKeysWithUsage();
            res.json(keys);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { key, name } = parseBody(req);
             if (!key || typeof key !== 'string') {
                return res.status(400).json({ error: 'Request body must include a valid API key (string)' });
            }
            const result = await geminiKeyService.addGeminiKey(key, name);
            res.status(201).json({ success: true, ...result });
        } catch (error) {
             if (error.message.includes('duplicate API key')) {
                return res.status(409).json({ error: 'Cannot add duplicate API key' });
            }
            next(error);
        }
    });

router.delete('/gemini-keys/:id', async (req, res, next) => {
    try {
        const keyId = req.params.id;
        if (!keyId) {
             return res.status(400).json({ error: 'Missing key ID in path' });
        }
        await geminiKeyService.deleteGeminiKey(keyId);
        res.json({ success: true, id: keyId });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});

// Base Gemini API URL - Default
const DEFAULT_GEMINI_URL = 'https://generativelanguage.googleapis.com';

// Helper to get the effective base URL for Gemini API, considering CF_GATEWAY env var
function getGeminiBaseUrl() {
    const customGateway = process.env.CF_GATEWAY;
    const effectiveGatewayUrl = customGateway && customGateway.trim() !== '' ? customGateway.trim().replace(/\/$/, '') : null;
    const baseUrl = effectiveGatewayUrl || DEFAULT_GEMINI_URL;
    // console.log(`Admin API using Gemini Base URL: ${baseUrl}`); // Optional logging
    return baseUrl;
}

// --- Test Gemini Key --- (/api/admin/test-gemini-key)
router.post('/test-gemini-key', async (req, res, next) => {
     try {
        const { keyId, modelId } = parseBody(req);
        if (!keyId || !modelId) {
             return res.status(400).json({ error: 'Request body must include keyId and modelId' });
        }

        // Fetch the actual key from the database
        const keyInfo = await configService.getDb('SELECT api_key FROM gemini_keys WHERE id = ?', [keyId]);
        if (!keyInfo || !keyInfo.api_key) {
            return res.status(404).json({ error: `API Key with ID '${keyId}' not found or invalid.` });
        }
        const apiKey = keyInfo.api_key;

        // Fetch model category for potential usage increment
        const modelsConfig = await configService.getModelsConfig();
        const modelCategory = modelsConfig[modelId]?.category;

        const testGeminiRequestBody = { contents: [{ role: "user", parts: [{ text: "Hi" }] }] };
        const baseUrl = getGeminiBaseUrl();
        const geminiUrl = `${baseUrl}/v1beta/models/${modelId}:generateContent`;

        let testResponseStatus = 500;
        let testResponseBody = null;
        let isSuccess = false;

        try {
            const response = await fetch(geminiUrl, {
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    'x-goog-api-key': apiKey
                },
                body: JSON.stringify(testGeminiRequestBody)
            });
            testResponseStatus = response.status;
            testResponseBody = await response.json(); // Attempt to parse JSON
            isSuccess = response.ok;

            if (isSuccess) {
                 // Increment usage and sync to GitHub
                 await geminiKeyService.incrementKeyUsage(keyId, modelId, modelCategory);
                 await geminiKeyService.clearKeyError(keyId);
            } else {
                 // Record 401/403 errors
                 if (testResponseStatus === 401 || testResponseStatus === 403) {
                     await geminiKeyService.recordKeyError(keyId, testResponseStatus);
                 }
            }

        } catch (fetchError) {
             console.error(`Error testing Gemini API key ${keyId}:`, fetchError);
             testResponseBody = { error: `Fetch error: ${fetchError.message}` };
             isSuccess = false;
             // Don't assume network error means key is bad, could be temporary
        }

        res.status(isSuccess ? 200 : testResponseStatus).json({
            success: isSuccess,
            status: testResponseStatus,
            content: testResponseBody
        });

    } catch (error) {
        // Errors from fetching keyInfo etc.
        next(error);
    }
});

// --- Get Available Gemini Models --- (/api/admin/gemini-models)
router.get('/gemini-models', async (req, res, next) => {
     try {
         // Find *any* valid key to make the models list request, without updating the rotation index
         // This prevents writing to the database and GitHub sync on page refreshes
         const availableKey = await geminiKeyService.getNextAvailableGeminiKey(null, false); // Don't update index for read-only operation
         if (!availableKey) {
             console.warn("No available Gemini key found to fetch models list.");
             return res.json([]); // Return empty list if no keys work
         }

         const baseUrl = getGeminiBaseUrl();
         const geminiUrl = `${baseUrl}/v1beta/models`;
         const response = await fetch(geminiUrl, { 
             method: 'GET', 
             headers: { 
                 'Content-Type': 'application/json',
                 'x-goog-api-key': availableKey.key
             } 
         });

         if (!response.ok) {
             const errorBody = await response.text();
             console.error(`Error fetching Gemini models list (key ${availableKey.id}): ${response.status} ${response.statusText}`, errorBody);
             // Don't mark the key as bad for a failed models list request
             return res.json([]); // Return empty on error
         }

         const data = await response.json();
         const processedModels = (data.models || [])
            .filter(model => model.name?.startsWith('models/')) // Ensure correct format
            .map((model) => ({
                 id: model.name.substring(7), // Extract ID
                 name: model.displayName || model.name.substring(7), // Prefer displayName
                 description: model.description,
                 // Add other potentially useful fields: supportedGenerationMethods, version, etc.
             }));

         res.json(processedModels);
     } catch (error) {
         console.error('Error handling /api/admin/gemini-models:', error);
         next(error);
     }
});


// --- Error Key Management ---
router.get('/error-keys', async (req, res, next) => {
    try {
        const errorKeys = await geminiKeyService.getErrorKeys();
        res.json(errorKeys);
    } catch (error) {
        next(error);
    }
});

router.post('/clear-key-error', async (req, res, next) => {
    try {
        const { keyId } = parseBody(req);
         if (!keyId || typeof keyId !== 'string') {
            return res.status(400).json({ error: 'Request body must include a valid keyId (string)' });
        }
        await geminiKeyService.clearKeyError(keyId);
        res.json({ success: true, id: keyId });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});


// --- Worker Key Management --- (/api/admin/worker-keys)
router.route('/worker-keys')
    .get(async (req, res, next) => {
        try {
            const keys = await configService.getAllWorkerKeys();
            res.json(keys);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { key, description } = parseBody(req);
            if (!key || typeof key !== 'string' || key.trim() === '') {
                 return res.status(400).json({ error: 'Request body must include a valid non-empty string: key' });
            }
            await configService.addWorkerKey(key.trim(), description);
            res.status(201).json({ success: true, key: key.trim() });
        } catch (error) {
            if (error.message.includes('already exists')) {
                return res.status(409).json({ error: error.message });
            }
            next(error);
        }
    });

router.delete('/worker-keys/:key', async (req, res, next) => { // Use key in path param
     try {
        const keyToDelete = decodeURIComponent(req.params.key); // Decode URL component
         if (!keyToDelete) {
             return res.status(400).json({ error: 'Missing worker key in path' });
         }
        await configService.deleteWorkerKey(keyToDelete);
        res.json({ success: true, key: keyToDelete });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});

router.post('/worker-keys/safety-settings', async (req, res, next) => { // Specific path for safety
    try {
        const { key, safetyEnabled } = parseBody(req);
        if (!key || typeof key !== 'string' || typeof safetyEnabled !== 'boolean') {
            return res.status(400).json({ error: 'Request body must include key (string) and safetyEnabled (boolean)' });
        }
        await configService.updateWorkerKeySafety(key, safetyEnabled);
        res.json({ success: true, key: key, safetyEnabled: safetyEnabled });
    } catch (error) {
         if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});


// --- Model Configuration Management --- (/api/admin/models)
router.route('/models')
    .get(async (req, res, next) => {
        try {
            const config = await configService.getModelsConfig();
            // Convert to array format expected by UI
            const modelList = Object.entries(config).map(([id, data]) => ({ id, ...data }));
            res.json(modelList);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => { // Add or Update
        try {
             const { id, category, dailyQuota, individualQuota } = parseBody(req);
             if (!id || !category || !['Pro', 'Flash', 'Custom'].includes(category)) {
                 return res.status(400).json({ error: 'Request body must include valid id and category (Pro, Flash, or Custom)' });
             }
             // Basic validation for quotas (more in service layer)
             const dailyQuotaNum = (dailyQuota === null || dailyQuota === undefined || dailyQuota === '') ? null : Number(dailyQuota);
             const individualQuotaNum = (individualQuota === null || individualQuota === undefined || individualQuota === '') ? null : Number(individualQuota);

             if ((dailyQuotaNum !== null && isNaN(dailyQuotaNum)) || (individualQuotaNum !== null && isNaN(individualQuotaNum))) {
                 return res.status(400).json({ error: 'Quotas must be numbers or null/empty.' });
             }

             await configService.setModelConfig(id, category, dailyQuotaNum, individualQuotaNum);
             res.status(200).json({ success: true, id, category, dailyQuota: dailyQuotaNum, individualQuota: individualQuotaNum }); // Use 200 for add/update simplicity
        } catch (error) {
             if (error.message.includes('must be a non-negative integer')) {
                return res.status(400).json({ error: error.message });
             }
            next(error);
        }
    });

router.delete('/models/:id', async (req, res, next) => { // Use ID in path
    try {
        const modelIdToDelete = decodeURIComponent(req.params.id);
         if (!modelIdToDelete) {
             return res.status(400).json({ error: 'Missing model ID in path' });
         }
        await configService.deleteModelConfig(modelIdToDelete);
        res.json({ success: true, id: modelIdToDelete });
    } catch (error) {
        if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        next(error);
    }
});


// --- Category Quota Management --- (/api/admin/category-quotas)
router.route('/category-quotas')
    .get(async (req, res, next) => {
        try {
            const quotas = await configService.getCategoryQuotas();
            res.json(quotas);
        } catch (error) {
            next(error);
        }
    })
    .post(async (req, res, next) => {
        try {
            const { proQuota, flashQuota } = parseBody(req);
            // Service layer handles detailed validation
             await configService.setCategoryQuotas(proQuota, flashQuota);
             res.json({ success: true, proQuota, flashQuota });
        } catch (error) {
             if (error.message.includes('must be non-negative numbers')) {
                 return res.status(400).json({ error: error.message });
             }
            next(error);
        }
    });


module.exports = router;
