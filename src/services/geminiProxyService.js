const fetch = require('node-fetch');
const { Readable } = require('stream');
const { syncToGitHub } = require('../db'); 
const configService = require('./configService');
const geminiKeyService = require('./geminiKeyService');
const transformUtils = require('../utils/transform');

// Base Gemini API URL - Default
const DEFAULT_GEMINI_URL = 'https://generativelanguage.googleapis.com';
// Read custom gateway URL from environment variable
const CF_GATEWAY_URL = process.env.CF_GATEWAY;

// Determine the actual base URL to use, removing trailing slashes if present
const effectiveGatewayUrl = CF_GATEWAY_URL && CF_GATEWAY_URL.trim() !== '' ? CF_GATEWAY_URL.trim().replace(/\/$/, '') : null;
const BASE_GEMINI_URL = effectiveGatewayUrl || DEFAULT_GEMINI_URL;

// Log the final base URL being used
console.log(`Using Gemini API Base URL: ${BASE_GEMINI_URL}`);

async function proxyChatCompletions(openAIRequestBody, workerApiKey, stream) {
    // Check if KEEPALIVE mode is enabled
    const keepAliveEnabled = process.env.KEEPALIVE === '1';
    
    const requestedModelId = openAIRequestBody?.model;

    if (!requestedModelId) {
        return { error: { message: "Missing 'model' field in request body" }, status: 400 };
    }
    if (!openAIRequestBody.messages || !Array.isArray(openAIRequestBody.messages)) {
        return { error: { message: "Missing or invalid 'messages' field in request body" }, status: 400 };
    }

    const MAX_RETRIES = 3;
    let lastError = null;
    let lastErrorStatus = 500;
    let modelInfo;
    let modelCategory;
    let isSafetyEnabled;
    let modelsConfig;

    try {
        // Fetch model config and safety settings once before the loop
        [modelsConfig, isSafetyEnabled] = await Promise.all([
            configService.getModelsConfig(),
            configService.getWorkerKeySafetySetting(workerApiKey) // Get safety setting for this worker key
        ]);
        
        // Check if web search functionality needs to be added
        // 1. Via web_search parameter or 2. Using a model ending with -search
        const isSearchModel = requestedModelId.endsWith('-search');
        const actualModelId = isSearchModel ? requestedModelId.replace('-search', '') : requestedModelId;
        
        // If KEEPALIVE is enabled, this is a streaming request, and safety is disabled, we'll handle it specially
        const useKeepAlive = !isSafetyEnabled && keepAliveEnabled && stream;
    
        // If using keepalive, we'll make a non-streaming request to Gemini but send streaming responses to client
        const actualStreamMode = useKeepAlive ? false : stream;

        // If it's a search model, use the original model ID to find model info
        const modelLookupId = isSearchModel ? actualModelId : requestedModelId;
        modelInfo = modelsConfig[modelLookupId];
        if (!modelInfo) {
            return { error: { message: `Model '${modelLookupId}' is not configured in the proxy.` }, status: 400 };
        }
        modelCategory = modelInfo.category;

        // --- Retry Loop ---
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            let selectedKey;
            try {
                // 1. Get Key inside the loop for each attempt
                // If it's a search model, use the original model ID to get the API key
                const keyModelId = isSearchModel ? actualModelId : requestedModelId;
                selectedKey = await geminiKeyService.getNextAvailableGeminiKey(keyModelId);

                // 2. Validate Key
                if (!selectedKey) {
                    console.error(`Attempt ${attempt}: No available Gemini API Key found.`);
                    if (attempt === 1) {
                        // If no key on first try, return 503 immediately
                        return { error: { message: "No available Gemini API Key configured or all keys are currently rate-limited/invalid." }, status: 503 };
                    } else {
                        // If no key on subsequent tries (after 429), return the last recorded 429 error
                         console.error(`Attempt ${attempt}: No more keys to try after previous 429.`);
                         return { error: lastError, status: lastErrorStatus };
                    }
                }

                console.log(`Attempt ${attempt}: Proxying request for model: ${requestedModelId}, Category: ${modelCategory}, KeyID: ${selectedKey.id}, Safety: ${isSafetyEnabled}`);

                // 3. Transform Request Body (remains the same)
                const { contents, systemInstruction, tools: geminiTools } = transformUtils.transformOpenAiToGemini(
                    openAIRequestBody,
                    requestedModelId,
                    isSafetyEnabled // Pass safety setting to transformer
                );

                if (contents.length === 0 && !systemInstruction) {
                    return { error: { message: "Request must contain at least one user or assistant message." }, status: 400 };
                }

                const geminiRequestBody = {
                    contents: contents,
                    generationConfig: {
                        ...(openAIRequestBody.temperature !== undefined && { temperature: openAIRequestBody.temperature }),
                        ...(openAIRequestBody.top_p !== undefined && { topP: openAIRequestBody.top_p }),
                        ...(openAIRequestBody.max_tokens !== undefined && { maxOutputTokens: openAIRequestBody.max_tokens }),
                        ...(openAIRequestBody.stop && { stopSequences: Array.isArray(openAIRequestBody.stop) ? openAIRequestBody.stop : [openAIRequestBody.stop] }),
                    },
                    ...(geminiTools && { tools: geminiTools }),
                    ...(systemInstruction && { systemInstruction: systemInstruction }),
                };

                if (openAIRequestBody.web_search === 1 || isSearchModel) {
                    console.log(`Web search enabled for this request (${isSearchModel ? 'model-based' : 'parameter-based'})`);
                    
                    // Create Google Search tool
                    const googleSearchTool = {
                        googleSearch: {}
                    };
                    
                    // Add to existing tools or create a new tools array
                    if (geminiRequestBody.tools) {
                        geminiRequestBody.tools = [...geminiRequestBody.tools, googleSearchTool];
                    } else {
                        geminiRequestBody.tools = [googleSearchTool];
                    }
                    
                    // Add a prompt at the end of the request to encourage the model to use search tools
                    geminiRequestBody.contents.push({
                        role: 'user',
                        parts: [{ text: '(Use search tools to get the relevant information and complete this request.)' }]
                    });
                }

                if (!isSafetyEnabled) {
                    geminiRequestBody.safetySettings = [
                        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }, 
                        { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }, 
                    ];
                     console.log("Applying safety settings.");
                }

                // 4. Prepare and Send Request to Gemini
                // If keepalive is enabled and original request was streaming, use non-streaming API
                const apiAction = actualStreamMode ? 'streamGenerateContent' : 'generateContent';
                
                // Build complete API URL using the determined BASE_GEMINI_URL
                // Use the original requestedModelId (including -search if present) for the API call
                const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models/${requestedModelId}:${apiAction}`; // Use requestedModelId
                
                const geminiRequestHeaders = {
                    'Content-Type': 'application/json',
                    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36`,
                    'X-Accel-Buffering': 'no',
                    'Cache-Control': 'no-cache, no-store, must-revalidate',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'x-goog-api-key': selectedKey.key
                };

                console.log(`Attempt ${attempt}: Sending ${actualStreamMode ? 'streaming' : 'non-streaming'} request to Gemini URL: ${geminiUrl}`);
                
                // Log if using keepalive mode
                if (keepAliveEnabled && stream) {
                    if (useKeepAlive) {
                        console.log(`Using KEEPALIVE mode: Client expects stream but sending non-streaming request to Gemini (Safety disabled)`);
                    } else {
                        console.log(`KEEPALIVE is enabled but safety is also enabled. Using normal streaming mode.`);
                    }
                }

                const geminiResponse = await fetch(geminiUrl, {
                    method: 'POST',
                    headers: geminiRequestHeaders,
                    body: JSON.stringify(geminiRequestBody),
                    size: 100 * 1024 * 1024,
                    timeout: 300000
                });

                // 5. Handle Gemini Response Status and Errors
                if (!geminiResponse.ok) {
                    const errorBodyText = await geminiResponse.text();
                    console.error(`Attempt ${attempt}: Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText}`, errorBodyText);

                    lastErrorStatus = geminiResponse.status; // Store status
                    try {
                        lastError = JSON.parse(errorBodyText).error || { message: errorBodyText }; // Try parsing, fallback to text
                    } catch {
                        lastError = { message: errorBodyText };
                    }
                     // Add type and code if not present from Gemini
                    if (!lastError.type) lastError.type = `gemini_api_error_${geminiResponse.status}`;
                    if (!lastError.code) lastError.code = geminiResponse.status;


                    // Handle specific errors impacting key status
                    if (geminiResponse.status === 429) {
                        // Pass the error message to the handle429Error function
                        const errorMessage = lastError?.message || errorBodyText;
                        console.log(`429 error message: ${errorMessage}`);
                        
                        // Record 429 for the key - use actualModelId for consistent counting
                        geminiKeyService.handle429Error(selectedKey.id, modelCategory, actualModelId, errorMessage)
                            .catch(err => console.error(`Error handling 429 for key ${selectedKey.id} in background:`, err));

                        // If not the last attempt, continue to the next key
                        if (attempt < MAX_RETRIES) {
                            console.warn(`Attempt ${attempt}: Received 429, trying next key...`);
                            continue; // Go to the next iteration of the loop
                        } else {
                            console.error(`Attempt ${attempt}: Received 429, but max retries reached.`);
                            // Fall through to return the last recorded 429 error after the loop
                        }
                    } else if (geminiResponse.status === 401 || geminiResponse.status === 403) {
                        // Record persistent error for the key
                        geminiKeyService.recordKeyError(selectedKey.id, geminiResponse.status)
                             .catch(err => console.error(`Error recording key error ${geminiResponse.status} for key ${selectedKey.id} in background:`, err));
                        // Do not retry for 401/403, break and return this error
                        break;
                    } else {
                         // For other errors (400, 500, etc.), don't retry, break and return the error
                         console.error(`Attempt ${attempt}: Received non-retryable error ${geminiResponse.status}.`);
                         break;
                    }
                } else {
                    // 6. Process Successful Response
                    console.log(`Attempt ${attempt}: Request successful with key ${selectedKey.id}.`);
                    // Increment usage count for the actual model ID, not the -search version
                    geminiKeyService.incrementKeyUsage(selectedKey.id, actualModelId, modelCategory)
                          .catch(err => console.error(`Error incrementing usage for key ${selectedKey.id} in background:`, err));

                    console.log(`Chat completions call completed successfully.`);

                    // For KEEPALIVE mode with streaming client request
                    if (useKeepAlive) {
                        // Get the complete non-streaming response
                        const geminiResponseData = await geminiResponse.json();

                        // Return the complete response data, let apiV1.js handle keepalive and response sending
                        return {
                            response: geminiResponseData, // Directly return the parsed JSON data
                            selectedKeyId: selectedKey.id,
                            modelCategory: modelCategory,
                            isKeepAlive: true, // Mark this as a keepalive mode response
                            requestedModelId: requestedModelId // Pass modelId for subsequent use
                        };
                    } else {
                        // Regular handling (non-KEEPALIVE)
                        return {
                            response: geminiResponse,
                            selectedKeyId: selectedKey.id,
                            modelCategory: modelCategory
                        };
                    }
                }

            } catch (fetchError) {
                 // Catch network errors or other errors during fetch/key selection within an attempt
                 console.error(`Attempt ${attempt}: Error during proxy call:`, fetchError);
                 lastError = { message: `Internal Proxy Error during attempt ${attempt}: ${fetchError.message}`, type: 'proxy_internal_error' };
                 lastErrorStatus = 500;
                 // If a network error occurs, break the loop, don't retry immediately
                 break;
            }
        } // --- End Retry Loop ---

        // If the loop finished without returning a success or a specific non-retryable error,
        // it means all retries resulted in 429 or we broke due to an error. Return the last recorded error.
        console.error(`All ${MAX_RETRIES} attempts failed. Returning last recorded error (Status: ${lastErrorStatus}).`);
        return { error: lastError, status: lastErrorStatus };


    } catch (initialError) {
         // Catch errors happening *before* the loop starts (e.g., getting initial config)
        console.error("Error before starting proxy attempts:", initialError);
        return {
            error: {
                message: `Internal Proxy Error: ${initialError.message}`,
                type: 'proxy_internal_error'
            },
            status: 500
        };
    }
}


module.exports = {
    proxyChatCompletions,
};
