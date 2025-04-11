export interface Env {
	// KV Namespaces
	GEMINI_KEYS_KV: KVNamespace;
	WORKER_CONFIG_KV: KVNamespace;

	// Static Assets (for admin UI)
	ASSETS: Fetcher;

	// Environment Variables
	ADMIN_PASSWORD?: string;
	SESSION_SECRET_KEY?: string;
	KEEPALIVE_ENABLED?: string; // Added for keepalive feature
	CF_GATEWAY?: string; // Custom Gemini API endpoint (e.g., Cloudflare AI Gateway)
}

// --- Constants ---
const SESSION_COOKIE_NAME = '__session';
const SESSION_DURATION_SECONDS = 1 * 60 * 60;
const DEFAULT_GEMINI_URL = 'https://generativelanguage.googleapis.com';

// Helper function to get the effective Gemini base URL
function getBaseGeminiUrl(env: Env): string {
	const customGateway = env.CF_GATEWAY;
	const effectiveGatewayUrl = customGateway && customGateway.trim() !== '' ? customGateway.trim().replace(/\/$/, '') : null;
	const baseUrl = effectiveGatewayUrl || DEFAULT_GEMINI_URL;
	// Log only once or conditionally if needed, as this might be called frequently
	// console.log(`Worker using Gemini API Base URL: ${baseUrl}`);
	return baseUrl;
}

// --- KV Keys ---
const KV_KEY_MODELS = "models";
const KV_KEY_CATEGORY_QUOTAS = "category_quotas";
const KV_KEY_WORKER_KEYS = "worker_keys";
const KV_KEY_WORKER_KEYS_SAFETY = "worker_keys_safety_settings";
const KV_KEY_GEMINI_KEY_LIST = "_config:key_list";
const KV_KEY_GEMINI_KEY_INDEX = "_config:key_index"; // Note: This index is no longer used by the new logic but kept for potential backward compatibility or other uses.
const KV_KEY_LAST_USED_GEMINI_KEY_ID = "_internal:last_used_gemini_key_id"; // Stores the ID of the last used key

// --- Interfaces ---
// Define the structure for model configuration
interface ModelConfig {
	category: 'Pro' | 'Flash' | 'Custom';
	dailyQuota?: number; // Only applicable for 'Custom' category
	individualQuota?: number; // Individual quota for Pro/Flash models
}

// Define the structure for category quotas
interface CategoryQuotas {
	proQuota: number;
	flashQuota: number;
}

// Define the structure for Gemini Key information stored in KV
interface GeminiKeyInfo {
	id: string;
	key: string;
	usage: number;
	usageDate: string;
	modelUsage?: Record<string, number>;
	categoryUsage?: { pro: number; flash: number };
	name?: string;
	errorStatus?: 401 | 403 | null; // Added to track 401/403 errors
	consecutive429Counts?: Record<string, number>; // Tracks consecutive 429 errors per model/category
}

/**
 * Helper function to get today's date in Los Angeles timezone (YYYY-MM-DD format)
 * Uses a more reliable method for timezone conversion
 */
function getTodayInLA(): string {
	// Get current date in Los Angeles timezone
	const date = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
	// Parse the date string into a Date object
	const laDate = new Date(date);
	// Format as YYYY-MM-DD
	return laDate.getFullYear() + '-' + 
		String(laDate.getMonth() + 1).padStart(2, '0') + '-' + 
		String(laDate.getDate()).padStart(2, '0');
}


export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const pathname = url.pathname;

		try {
			// API endpoint for OpenAI compatibility
			if (pathname.startsWith('/v1/')) {
				if (request.method === 'OPTIONS') {
					return handleOptions(request);
				}
				return await handleApiV1(request, env, ctx);
			}

			// --- Login Page ---
			if (pathname === '/login') {
				// Serve login.html using ASSETS fetcher
				const loginUrl = new URL(url);
				loginUrl.pathname = '/login.html';
				const loginRequest = new Request(loginUrl.toString(), request);
				try {
					const assetResponse = await env.ASSETS.fetch(loginRequest);
					if (assetResponse.status === 404) {
						return new Response(`Login page not found at /public/login.html`, { status: 404 });
					}
					return assetResponse;
				} catch (e) {
					console.error("Error fetching login page asset:", e);
					return new Response(`Error fetching login page asset`, { status: 500 });
				}
			}

			// --- Login/Logout API ---
			if (pathname === '/api/login' && request.method === 'POST') {
				return await handleLoginRequest(request, env);
			}
			if (pathname === '/api/logout' && request.method === 'POST') {
				return handleLogoutRequest();
			}

			// --- Protected Admin Routes ---
			const requireAuth = createAuthMiddleware(env);

			// Admin UI endpoint (Protected)
			if (pathname === '/admin' || pathname.startsWith('/admin/')) {
				return requireAuth(request, async () => {
					// Serve static assets for the admin UI (HTML, CSS, JS)
					const adminPath = pathname === '/admin' || pathname === '/admin/' ? '/admin/index.html' : pathname;
					const assetUrl = new URL(url);
					assetUrl.pathname = adminPath;
					const modifiedRequest = new Request(assetUrl.toString(), request);
					try {
						const assetResponse = await env.ASSETS.fetch(modifiedRequest);
						if (assetResponse.status === 404) {
							return new Response(`Admin asset not found: ${adminPath}`, { status: 404 });
						}
						return assetResponse;
					} catch (e) {
						console.error("Error fetching admin asset:", e);
						return new Response(`Error fetching admin asset: ${adminPath}`, { status: 500 });
					}
				});
			}

			// Internal API for the admin UI (Protected)
			if (pathname.startsWith('/api/admin/')) {
				if (request.method === 'OPTIONS') {
					return handleOptions(request);
				}
				return requireAuth(request, async () => {
					return await handleAdminApi(request, env, ctx);
				});
			}

			// --- Root Path ---
			if (pathname === '/') {
				const sessionValid = await verifySessionCookie(request, env);
				if (sessionValid) {
					return Response.redirect(url.origin + '/admin', 302);
				} else {
					return Response.redirect(url.origin + '/login', 302);
				}
			}

			// --- Default Not Found ---
			return new Response('Not Found', { status: 404 });

		} catch (error) {
			console.error('Error in fetch handler:', error);
			const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json', ...corsHeaders() },
			});
		}
	},
};

// --- CORS Helper ---
function corsHeaders(): Record<string, string> {
	return {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-requested-with',
		'Access-Control-Max-Age': '86400',
	};
}

// Handle OPTIONS preflight requests
function handleOptions(request: Request): Response {
	// Ensure the request has Access-Control-Request-Method header
	if (
		request.headers.get('Origin') !== null &&
		request.headers.get('Access-Control-Request-Method') !== null &&
		request.headers.get('Access-Control-Request-Headers') !== null
	) {
		// Handle CORS preflight requests.
		return new Response(null, {
			headers: corsHeaders(),
		});
	} else {
		// Handle standard OPTIONS request.
		return new Response(null, {
			headers: {
				Allow: 'GET, POST, PUT, DELETE, OPTIONS',
			},
		});
	}
}


// --- API v1 Handler ---
async function handleApiV1(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const pathname = url.pathname;

	// Worker API Key Authentication
	const workerApiKey = request.headers.get('Authorization')?.replace('Bearer ', '');
	if (!workerApiKey || !(await isValidWorkerApiKey(workerApiKey, env))) {
		return new Response(JSON.stringify({ error: 'Invalid or missing API key' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json', ...corsHeaders() },
		});
	}

	if (pathname === '/v1/chat/completions') {
		if (request.method === 'OPTIONS') {
			return handleOptions(request);
		}
		return await handleV1ChatCompletions(request, env, ctx);
	}

	if (pathname === '/v1/models') {
		return await handleV1Models(request, env, ctx);
	}

	return new Response('Not Found in /v1/', { status: 404, headers: corsHeaders() });
}

// --- API v1 Endpoint Implementations ---

// Helper to parse data URI
function parseDataUri(dataUri: string): { mimeType: string; data: string } | null {
	const match = dataUri.match(/^data:(.+?);base64,(.+)$/);
	if (!match) return null;
	return { mimeType: match[1], data: match[2] };
}

// Helper to transform OpenAI request body parts (messages, tools) to Gemini format
// Added requestedModelId and isSafetyEnabled parameters
function transformOpenAiToGemini(requestBody: any, requestedModelId?: string, isSafetyEnabled?: boolean): { contents: any[]; systemInstruction?: any; tools?: any[] } {
	const messages = requestBody.messages || [];
	const openAiTools = requestBody.tools;

	// 1. Transform Messages
	const contents: any[] = [];
	let systemInstruction: any | undefined = undefined;
	messages.forEach((msg: any) => {
		let role: string | undefined = undefined;
		let parts: any[] = [];

		// 1. Map Role
		switch (msg.role) {
			case 'user':
				role = 'user';
				break;
			case 'assistant':
				role = 'model';
				break;
			case 'system':
				// If safety is disabled OR it's a gemma model, treat system as user
				if (isSafetyEnabled === false || (requestedModelId && requestedModelId.startsWith('gemma'))) {
					console.log(`Safety disabled (${isSafetyEnabled}) or Gemma model detected (${requestedModelId}). Treating system message as user message.`);
					role = 'user';
					// Content processing for 'user' role will happen below
				}
				// Otherwise (safety enabled and not gemma), create systemInstruction
				else {
					if (typeof msg.content === 'string') {
						systemInstruction = { role: "system", parts: [{ text: msg.content }] };
					} else if (Array.isArray(msg.content)) { // Handle complex system prompts if needed
						const textContent = msg.content.find((p: any) => p.type === 'text')?.text;
						if (textContent) {
							systemInstruction = { role: "system", parts: [{ text: textContent }] };
						}
					}
					return; // Skip adding this message to 'contents' when creating systemInstruction
				}
				break; // Break for 'system' role (safety disabled/gemma case falls through to content processing)
			default:
				console.warn(`Unknown role encountered: ${msg.role}. Skipping message.`);
				return; // Skip unknown roles
		}

		// 2. Map Content to Parts (existing logic)
		if (typeof msg.content === 'string') {
			parts.push({ text: msg.content });
		} else if (Array.isArray(msg.content)) {
			// Handle multi-part messages (text and images)
			msg.content.forEach((part: any) => {
				if (part.type === 'text') {
					parts.push({ text: part.text });
				} else if (part.type === 'image_url') {
					const imageData = parseDataUri(part.image_url?.url);
					if (imageData) {
						parts.push({ inlineData: imageData });
					} else {
						console.warn(`Could not parse image_url: ${part.image_url?.url}. Skipping image part.`);
					}
				} else {
					console.warn(`Unknown content part type: ${part.type}. Skipping part.`);
				}
			});
		} else {
			console.warn(`Unsupported content type for role ${msg.role}: ${typeof msg.content}. Skipping message.`);
			return;
		}

		// Add the transformed message to contents if it has a role and parts
		if (role && parts.length > 0) {
			contents.push({ role, parts });
		}
	});

	// 2. Transform Tools
	let geminiTools: any[] | undefined = undefined;
	if (openAiTools && Array.isArray(openAiTools) && openAiTools.length > 0) {
		const functionDeclarations = openAiTools
			.filter(tool => tool.type === 'function' && tool.function)
			.map(tool => {
				// Create a copy of the parameters to avoid modifying the original request object
				const parameters = tool.function.parameters ? { ...tool.function.parameters } : undefined;
				// Remove the $schema field if it exists in the copy
				if (parameters && parameters.$schema !== undefined) {
					delete parameters.$schema;
					console.log(`Removed '$schema' from parameters for tool: ${tool.function.name}`); // Optional: Log removal
				}
				return {
					name: tool.function.name,
					description: tool.function.description,
					parameters: parameters // Assign the modified copy
				};
			});

		if (functionDeclarations.length > 0) {
			geminiTools = [{ functionDeclarations }];
		}
	}

	return { contents, systemInstruction, tools: geminiTools };
}


// Helper to transform Gemini stream chunk to OpenAI stream chunk
function transformGeminiStreamChunk(geminiChunk: any, modelId: string): string | null {
	try {
		if (!geminiChunk || !geminiChunk.candidates || !geminiChunk.candidates.length) {
			if (geminiChunk?.usageMetadata) {
				return null;
			}
			console.warn("Received empty or invalid Gemini stream chunk:", geminiChunk);
			return null;
		}

		const candidate = geminiChunk.candidates[0];
		let contentText: string | null = null;
		let toolCalls: any[] | undefined = undefined;

		if (candidate.content?.parts?.length > 0) {
			const textParts = candidate.content.parts.filter((part: any) => part.text !== undefined);
			const functionCallParts = candidate.content.parts.filter((part: any) => part.functionCall !== undefined);

			if (textParts.length > 0) {
				contentText = textParts.map((part: any) => part.text).join("");
			}

			if (functionCallParts.length > 0) {
				toolCalls = functionCallParts.map((part: any, index: number) => ({
					index: index,
					id: `call_${Date.now()}_${index}`,
					type: "function",
					function: {
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args || {}),
					},
				}));
			}
		}

		// Determine finish reason
		let finishReason = candidate.finishReason;
		if (finishReason === "STOP") finishReason = "stop";
		else if (finishReason === "MAX_TOKENS") finishReason = "length";
		else if (finishReason === "SAFETY" || finishReason === "RECITATION") finishReason = "content_filter";
		else if (finishReason === "TOOL_CALLS" || (toolCalls && toolCalls.length > 0)) {
			// Always set to tool_calls if we have tool calls, regardless of the original finish reason
			finishReason = "tool_calls";
		}

		// Construct the delta part
		const delta: any = {};
		if (candidate.content?.role && (contentText !== null || (toolCalls && toolCalls.length > 0))) {
			// Include role only if there's content or tool calls
			delta.role = candidate.content.role === 'model' ? 'assistant' : candidate.content.role;
		}
		
		// Important: If we have tool calls but no content text, explicitly set content to null
		if (toolCalls && toolCalls.length > 0) {
			delta.tool_calls = toolCalls;
			if (contentText === null) {
				delta.content = null; // Explicitly set to null when there's only tool calls
			} else {
				delta.content = contentText;
			}
		} else if (contentText !== null) {
			delta.content = contentText;
		}


		// Only create a chunk if there's something to send (content, tool_calls, or finish_reason)
		if (Object.keys(delta).length === 0 && !finishReason) {
			return null;
		}

		const openaiChunk = {
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: candidate.index || 0,
					delta: delta,
					finish_reason: finishReason || null,
					logprobs: null,
				},
			],
		};

		return `data: ${JSON.stringify(openaiChunk)}\n\n`;

	} catch (e) {
		console.error("Error transforming Gemini stream chunk:", e, "Chunk:", geminiChunk);
		return null;
	}
}

// --- Helper Functions for Keepalive ---

/**
 * Encodes a keepalive chunk in SSE format.
 */
function encodeKeepAliveChunk(modelId: string): Uint8Array {
	const keepAliveData = {
		id: `chatcmpl-keepalive-${Date.now()}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: modelId,
		choices: [{
			index: 0,
			delta: {}, // Empty delta signifies keepalive
			finish_reason: null
		}]
	};
	const encoder = new TextEncoder();
	return encoder.encode(`data: ${JSON.stringify(keepAliveData)}\n\n`);
}

/**
 * Encodes standard OpenAI response parts (role, content, finish) into SSE chunks.
 */
function encodeOpenAiResponseChunk(
	type: 'role' | 'content' | 'finish',
	modelId: string,
	data?: { role?: string; content?: string | null; finish_reason?: string | null; tool_calls?: any[] }
): Uint8Array {
	const chunkId = `chatcmpl-${type}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
	const delta: any = {};
	let finish_reason: string | null = null;

	if (type === 'role' && data?.role) {
		delta.role = data.role;
	} else if (type === 'content') {
		// Handle both content and potential tool_calls in the 'content' phase
		if (data?.tool_calls) {
			delta.tool_calls = data.tool_calls;
			// If there are tool calls, content should be explicitly null unless provided
			delta.content = data?.content !== undefined ? data.content : null;
		} else if (data?.content !== undefined) {
			delta.content = data.content;
		}
	} else if (type === 'finish') {
		finish_reason = data?.finish_reason || "stop"; // Default to stop if not provided
	}

	const openaiChunk = {
		id: chunkId,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: modelId,
		choices: [{
			index: 0,
			delta: delta,
			finish_reason: finish_reason
		}]
	};
	const encoder = new TextEncoder();
	return encoder.encode(`data: ${JSON.stringify(openaiChunk)}\n\n`);
}


// --- Helper to transform Gemini non-stream response to OpenAI response ---
// Now returns the parsed object instead of a string
function transformGeminiResponseToOpenAIObject(geminiResponse: any, modelId: string): any {
	try {
		const candidate = geminiResponse.candidates?.[0];
		if (!candidate) {
			// Check for promptFeedback for blocked prompts
			if (geminiResponse.promptFeedback?.blockReason) {
				console.warn(`Gemini response blocked. Reason: ${geminiResponse.promptFeedback.blockReason}`);
				// Return a structured error response mimicking OpenAI format
				return {
					id: `chatcmpl-blocked-${Date.now()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1000),
					model: modelId,
					choices: [{
						index: 0,
						message: {
							role: "assistant",
							content: `[Content Blocked: ${geminiResponse.promptFeedback.blockReason}]`
						},
						finish_reason: "content_filter",
						logprobs: null,
					}],
					usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, // Usage might be missing
				};
			}
			// If no candidates and no block reason, throw error
			throw new Error("No candidates or block reason found in Gemini response");
		}

		let contentText: string | null = null;
		let toolCalls: any[] | undefined = undefined;

		if (candidate.content?.parts?.length > 0) {
			const textParts = candidate.content.parts.filter((part: any) => part.text !== undefined);
			const functionCallParts = candidate.content.parts.filter((part: any) => part.functionCall !== undefined);

			if (textParts.length > 0) {
				contentText = textParts.map((part: any) => part.text).join("");
			}

			if (functionCallParts.length > 0) {
				toolCalls = functionCallParts.map((part: any, index: number) => ({
					id: `call_${Date.now()}_${index}`,
					type: "function",
					function: {
						name: part.functionCall.name,
						arguments: JSON.stringify(part.functionCall.args || {}),
					},
				}));
			}
		}

		// Map finish reason
		let finishReason = candidate.finishReason;
		if (finishReason === "STOP") finishReason = "stop";
		else if (finishReason === "MAX_TOKENS") finishReason = "length";
		else if (finishReason === "SAFETY" || finishReason === "RECITATION") finishReason = "content_filter";
		else if (finishReason === "TOOL_CALLS" || (toolCalls && toolCalls.length > 0)) {
			finishReason = "tool_calls";
		}

		// Construct the message object
		const message: any = {
			role: "assistant"
		};
		
		// Important: If we have tool calls but no content text, explicitly set content to null
		if (toolCalls && toolCalls.length > 0) {
			message.tool_calls = toolCalls;
			message.content = contentText !== null ? contentText : null;
		} else {
			message.content = contentText;
		}

		// Map usage
		const usage = {
			prompt_tokens: geminiResponse.usageMetadata?.promptTokenCount || 0,
			completion_tokens: geminiResponse.usageMetadata?.candidatesTokenCount || 0,
			total_tokens: geminiResponse.usageMetadata?.totalTokenCount || 0,
		};

		const openaiResponse = {
			id: `chatcmpl-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [
				{
					index: candidate.index || 0,
					message: message,
					finish_reason: finishReason || null,
					logprobs: null,
				},
			],
			usage: usage,
			// Include prompt feedback if available
			...(geminiResponse.promptFeedback && { prompt_feedback: geminiResponse.promptFeedback })
		};
		// Return the object directly
		return openaiResponse;
	} catch (e) {
		console.error("Error transforming Gemini non-stream response:", e, "Response:", geminiResponse);
		// Return an error object structure in OpenAI format
		return {
			id: `chatcmpl-error-${Date.now()}`,
			object: "chat.completion",
			created: Math.floor(Date.now() / 1000),
			model: modelId,
			choices: [{
				index: 0,
				message: { role: "assistant", content: `[Error processing Gemini response: ${e instanceof Error ? e.message : String(e)}]` },
				finish_reason: "error",
				logprobs: null,
			}],
			usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
		};
	}
}


async function handleV1ChatCompletions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	console.log("Handling /v1/chat/completions (Native Gemini)");

	let requestBody: any;
	let requestedModelId: string | undefined;
	let stream: boolean = false;
	let workerApiKey: string | null = null;
	const isKeepAliveEnabled = env.KEEPALIVE_ENABLED === 'true'; // Check keepalive env var

	try {
		requestBody = await request.json();
		requestedModelId = requestBody?.model;
		stream = requestBody?.stream ?? false;
	} catch (e) {
		console.error("Failed to parse request body:", e);
		return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
	}

	if (!requestedModelId) {
		return new Response(JSON.stringify({ error: "Missing 'model' field in request body" }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
	}
	if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
		return new Response(JSON.stringify({ error: "Missing or invalid 'messages' field in request body" }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
	}

	// Get and store Worker API Key for later use
	workerApiKey = request.headers.get('Authorization')?.replace('Bearer ', '') || null;

	const MAX_RETRIES = 3;
	let lastErrorBody: any = { error: "Failed to process request after multiple retries." };
	let lastErrorStatus = 500;
	let modelInfo: ModelConfig | undefined;
	let modelCategory: 'Pro' | 'Flash' | 'Custom' | undefined;
	let safetyEnabled = true; // Default safety
	let modelsConfig: Record<string, ModelConfig> | null;
	let safetySettingsJson: string | null;
	let useKeepAlive = false; // Initialize keepalive flag

	try {
		// Fetch models config and safety settings once before the loop
		[modelsConfig, safetySettingsJson] = await Promise.all([
			env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json") as Promise<Record<string, ModelConfig> | null>,
			workerApiKey ? env.WORKER_CONFIG_KV.get(KV_KEY_WORKER_KEYS_SAFETY) : Promise.resolve(null) // Fetches string or null
		]);

		// Determine actual model ID (strip -search suffix if present) BEFORE looking up config
		const isSearchModel = requestedModelId.endsWith('-search');
		const actualModelId = isSearchModel ? requestedModelId.replace('-search', '') : requestedModelId;

		// Look up model config using the actual model ID
		modelInfo = modelsConfig?.[actualModelId];
		if (!modelInfo) {
			// Use actualModelId in the error message for clarity
			return new Response(JSON.stringify({ error: `Model '${actualModelId}' (base for '${requestedModelId}') is not configured.` }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
		}
		modelCategory = modelInfo.category; // Category comes from the base model config

		// Determine safety settings based on worker key
		if (workerApiKey && safetySettingsJson) {
			try {
				const safetySettings = JSON.parse(safetySettingsJson) as Record<string, { safetyEnabled: boolean }>;
				if (safetySettings[workerApiKey]) {
					safetyEnabled = safetySettings[workerApiKey].safetyEnabled;
				}
			} catch (e) {
				console.error("Error parsing safety settings:", e);
				safetyEnabled = true; // Default to true if parsing fails
			}
		}
		console.log(`Safety settings for this request: ${safetyEnabled}`);

		// --- Determine if Keepalive Mode should be used ---
		useKeepAlive = isKeepAliveEnabled && stream && !safetyEnabled;
		if (useKeepAlive) {
			console.log("KEEPALIVE Mode Activated: Streaming request with safety disabled.");
		}

		// --- Transform Request Body ---
		const { contents, systemInstruction, tools: geminiTools } = transformOpenAiToGemini(requestBody, requestedModelId, safetyEnabled);
		if (contents.length === 0 && !systemInstruction) {
			return new Response(JSON.stringify({ error: "No valid user, assistant, or converted system messages found." }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
		}

		const geminiRequestBody: any = {
			contents: contents,
			generationConfig: {
				...(requestBody.temperature && { temperature: requestBody.temperature }),
				...(requestBody.top_p && { topP: requestBody.top_p }),
				...(requestBody.max_tokens && { maxOutputTokens: requestBody.max_tokens }),
				...(requestBody.stop && { stopSequences: Array.isArray(requestBody.stop) ? requestBody.stop : [requestBody.stop] }),
			}
		};
		if (!safetyEnabled) {
			geminiRequestBody.safetySettings = [
				{ category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' }, 
				{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
				{ category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
				{ category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
				{ category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' } 
			];
		}
		if (systemInstruction) geminiRequestBody.systemInstruction = systemInstruction;
		if (geminiTools) geminiRequestBody.tools = geminiTools;


		// --- Retry Loop ---
		for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
			let selectedKey: { id: string; key: string } | null = null;
			try {
				// 1. Get Key inside the loop for each attempt
				// Pass modelInfo and categoryQuotas to avoid fetching them repeatedly inside getNextAvailableGeminiKey
				const categoryQuotasConfig = await env.WORKER_CONFIG_KV.get(KV_KEY_CATEGORY_QUOTAS, "json") as CategoryQuotas | null;
				selectedKey = await getNextAvailableGeminiKey(env, ctx, requestedModelId);

				// 2. Validate Key
				if (!selectedKey) {
					console.error(`Attempt ${attempt}: No available Gemini API Key found.`);
					if (attempt === 1) {
						lastErrorBody = { error: "No available Gemini API Key configured or all keys are currently rate-limited/invalid." };
						lastErrorStatus = 503;
						break; // Exit loop immediately if no key on first try
					} else {
						console.error(`Attempt ${attempt}: No more keys to try after previous 429.`);
						// Keep the last recorded 429 error
						break; // Exit loop
					}
				}
				
				// --- Simple Quota Check (Moved inside loop, simplified as getNextAvailable does thorough check) ---
				// This is a quick check; getNextAvailableGeminiKey already filters based on quota
				const keyKvName = `key:${selectedKey.id}`;
				const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
				if (keyInfoJson) {
					try {
						const keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
						const todayInLA = getTodayInLA();
						if (keyInfoData.usageDate === todayInLA) {
							// Check if error status exists
							if (keyInfoData.errorStatus === 401 || keyInfoData.errorStatus === 403) {
								console.warn(`Attempt ${attempt}: Key ${selectedKey.id} has error status ${keyInfoData.errorStatus}, skipping.`);
								continue; // Try next key immediately
							}
							// Note: Detailed quota check is primarily handled by getNextAvailableGeminiKey now
						}
					} catch (e) {
						console.error(`Attempt ${attempt}: Failed to parse key info for quick check (key: ${selectedKey.id}):`, e);
						// Continue to attempt fetch anyway? Or skip? Let's skip.
						continue;
					}
				} else {
					console.warn(`Attempt ${attempt}: Key info for ${selectedKey.id} not found in KV. Skipping.`);
					continue; // Key exists in list but not in detail, skip
				}
				// --- End Simple Quota Check ---


				console.log(`Attempt ${attempt}: Proxying request for model: ${requestedModelId}, Category: ${modelCategory}, KeyID: ${selectedKey.id}, Safety: ${safetyEnabled}, KeepAlive: ${useKeepAlive}`);

				// Check if web search functionality needs to be enabled
				// 1. Via web_search parameter or 2. Using a model ending with -search
				// isSearchModel and actualModelId are now calculated earlier (before modelInfo lookup)
				// const isSearchModel = requestedModelId.endsWith('-search'); // Keep for reference if needed elsewhere
				// const actualModelId = isSearchModel ? requestedModelId.replace('-search', '') : requestedModelId; // Keep for reference if needed elsewhere

				if (requestBody.web_search === 1 || isSearchModel) {
					console.log(`Web search enabled for this request (${isSearchModel ? 'model-based' : 'parameter-based'})`);

					// Create Google search tool
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
						parts: [{ text: 'Use search tools to retrieve content' }]
					});
				}

				// 4. Prepare and Send Request to Gemini
				// If keepalive is active, force non-streaming, otherwise use requested stream setting
				const actualStreamMode = useKeepAlive ? false : stream;
				const apiAction = actualStreamMode ? 'streamGenerateContent' : 'generateContent';
				const querySeparator = actualStreamMode ? '?alt=sse&' : '?'; // Use alt=sse only if actually streaming to Gemini

				// For -search models, use the actual model ID (without -search) for the API call URL
				const BASE_GEMINI_URL = getBaseGeminiUrl(env); // Get dynamic base URL
				const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models/${actualModelId}:${apiAction}${querySeparator}key=${selectedKey.key}`; // Already using actualModelId here, which is correct

				const geminiRequestHeaders = new Headers();
				geminiRequestHeaders.set('Content-Type', 'application/json');
				geminiRequestHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36'); // Chrome UA
				geminiRequestHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
				geminiRequestHeaders.set('Pragma', 'no-cache');
				geminiRequestHeaders.set('Expires', '0');
				// Accept header depends on actual call type to Gemini
				geminiRequestHeaders.set('Accept', actualStreamMode ? 'text/event-stream' : 'application/json');

				console.log(`Attempt ${attempt}: Sending ${actualStreamMode ? 'streaming' : 'non-streaming'} request to Gemini URL: ${geminiUrl}`);

				const geminiResponse = await fetch(geminiUrl, {
					method: 'POST',
					headers: geminiRequestHeaders,
					body: JSON.stringify(geminiRequestBody),
				});

				// 5. Handle Gemini Response Status and Errors
				if (!geminiResponse.ok) {
					const errorBodyText = await geminiResponse.text(); // Read error body once
					console.error(`Attempt ${attempt}: Gemini API error: ${geminiResponse.status} ${geminiResponse.statusText}`, errorBodyText);

					lastErrorStatus = geminiResponse.status;
					try {
						// Try to parse standard Gemini error structure first
						const parsedError = JSON.parse(errorBodyText);
						lastErrorBody = parsedError.error ? { error: parsedError.error } : { error: { message: errorBodyText, code: geminiResponse.status } };
					} catch {
						// Fallback if parsing fails
						lastErrorBody = { error: { message: errorBodyText, code: geminiResponse.status } };
					}
					if (!lastErrorBody.error.type) lastErrorBody.error.type = `gemini_api_error_${geminiResponse.status}`;

					// Handle specific errors impacting key status
					if (geminiResponse.status === 429) {
						// Get error message
						const errorMessage = lastErrorBody?.error?.message || errorBodyText;
						console.log(`429 error message: ${errorMessage}`);
						
						ctx.waitUntil(handle429Error(selectedKey.id, env, modelCategory!, actualModelId, errorMessage));
						if (attempt < MAX_RETRIES) {
							console.warn(`Attempt ${attempt}: Received 429, trying next key...`);
							continue; // Go to the next iteration
						} else {
							console.error(`Attempt ${attempt}: Received 429, but max retries reached.`);
							break; // Max retries reached for 429
						}
					} else if (geminiResponse.status === 401 || geminiResponse.status === 403) {
						ctx.waitUntil(recordKeyError(selectedKey.id, env, geminiResponse.status as 401 | 403));
						break; // Do not retry for 401/403
					} else {
						// For other errors (400, 500, etc.), do not retry
						console.error(`Attempt ${attempt}: Received non-retryable error ${geminiResponse.status}.`);
						break;
					}
				} else {
					// 6. Process Successful Response
					console.log(`Attempt ${attempt}: Request successful with key ${selectedKey.id}.`);
					// Increment usage using the actual model ID
					ctx.waitUntil(incrementKeyUsage(selectedKey.id, env, actualModelId, modelCategory, true)); // Reset 429 counters on success

					// --- Handle Response Transformation ---
					const responseHeaders = new Headers({
						// Always set stream headers if the *original* request was stream, even for keepalive
						'Content-Type': stream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
						'Cache-Control': 'no-cache',
						'Connection': stream ? 'keep-alive' : 'close', // Keep-alive only for streams
						...corsHeaders()
					});

					// --- KEEPALIVE MODE ---
					if (useKeepAlive) {
						const geminiJson = await geminiResponse.json(); // Get full response (since actualStreamMode was false)
						console.log("Processing successful response in KEEPALIVE mode.");

						const keepAliveStream = new ReadableStream({
							async start(controller) {
								let keepAliveTimer: number | undefined = undefined;
								let isCancelled = false;

								// Function to send keepalive chunks periodically
								const sendKeepAlive = () => {
									if (isCancelled) return;
									try {
										controller.enqueue(encodeKeepAliveChunk(requestedModelId!));
										console.log("Keepalive chunk sent.");
										keepAliveTimer = setTimeout(sendKeepAlive, 5000); // Send every 5 seconds
									} catch (e) {
										console.error("Error sending keepalive chunk:", e);
										clearTimeout(keepAliveTimer);
										// Attempt to close stream gracefully on error
										try { controller.close(); } catch (_) { }
									}
								};

								try {
									// Send the first keepalive immediately
									controller.enqueue(encodeKeepAliveChunk(requestedModelId!));
									console.log("Initial keepalive chunk sent.");
									keepAliveTimer = setTimeout(sendKeepAlive, 5000);

									// Transform the complete Gemini response
									const openaiResponseObject = transformGeminiResponseToOpenAIObject(geminiJson, requestedModelId!);

									// Extract necessary parts
									const finalMessage = openaiResponseObject?.choices?.[0]?.message;
									const finalFinishReason = openaiResponseObject?.choices?.[0]?.finish_reason;

									// Delay slightly before sending the full response
									await new Promise(resolve => setTimeout(resolve, 1000));

									if (isCancelled) {
										console.log("Keepalive stream cancelled before sending full response.");
										clearTimeout(keepAliveTimer);
										return;
									}

									// Stop sending keepalive messages
									clearTimeout(keepAliveTimer);
									console.log("Keepalive timer cleared.");

									// Send a complete response in one chunk instead of multiple chunks
									// Create a single OpenAI response chunk with all data
									const encoder = new TextEncoder();
									const completeResponseChunk = {
										id: `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
										object: "chat.completion.chunk",
										created: Math.floor(Date.now() / 1000),
										model: requestedModelId!,
										choices: [{
											index: 0,
											delta: {
												role: 'assistant',
												content: finalMessage?.content,
												...(finalMessage?.tool_calls ? { tool_calls: finalMessage.tool_calls } : {})
											},
											finish_reason: finalFinishReason || "stop"
										}]
									};
									controller.enqueue(encoder.encode(`data: ${JSON.stringify(completeResponseChunk)}\n\n`));

									// Send DONE signal
									controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));

									// Close the stream
									controller.close();
									console.log("Keepalive stream finished successfully.");

								} catch (err) {
									console.error("Error during keepalive stream processing:", err);
									clearTimeout(keepAliveTimer); // Ensure timer is cleared on error
									// Try to send an error chunk before closing
									try {
										const errorChunk = encodeOpenAiResponseChunk('content', requestedModelId!, { content: `[Keepalive Processing Error: ${err instanceof Error ? err.message : String(err)}]` });
										controller.enqueue(errorChunk);
										controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
									} catch (e) {
										console.error("Failed to send error chunk in keepalive:", e)
									}
									try { controller.close(); } catch (_) { } // Close stream on error
								}
							},
							cancel(reason) {
								console.log("Keepalive stream cancelled.", reason);
								// Cleanup logic if needed (e.g., clear timers, although start handles this)
								// Set a flag or mechanism for the async start function to check
								// Note: Direct cancellation handling within start is tricky, often relies on checks
							}
						});

						return new Response(keepAliveStream, { status: 200, headers: responseHeaders });

					}
					// --- STANDARD STREAMING MODE ---
					else if (stream && geminiResponse.body) {
						console.log("Processing successful response in STANDARD STREAMING mode.");
						const textDecoder = new TextDecoder();
						let buffer = '';
						const transformer = new TransformStream({
							async transform(chunk, controller) {
								buffer += textDecoder.decode(chunk, { stream: true });
								const lines = buffer.split('\n');
								buffer = lines.pop() || ''; // Keep the potentially incomplete last line
								for (const line of lines) {
									if (line.startsWith('data: ')) {
										try {
											// Skip empty data lines sometimes sent by Gemini
											const trimmedData = line.substring(6).trim();
											if (trimmedData.length === 0) continue;

											if (trimmedData === '[DONE]') {
												// Gemini itself doesn't send [DONE] in SSE, but handle defensively
												controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
												continue;
											}
											const jsonData = JSON.parse(trimmedData);
											// Pass requestedModelId (with -search if present) to transformer for correct display in client
											const openaiChunkStr = transformGeminiStreamChunk(jsonData, requestedModelId!);
											if (openaiChunkStr) controller.enqueue(new TextEncoder().encode(openaiChunkStr));
										} catch (e) {
											console.error("Error parsing/transforming stream line:", line, e);
											// Send an error chunk in the stream
											const errorMsg = `Error processing stream chunk: ${e instanceof Error ? e.message : String(e)}`;
											const errorChunk = encodeOpenAiResponseChunk('content', requestedModelId!, { content: `[${errorMsg}]` });
											controller.enqueue(errorChunk);
										}
									}
								}
							},
							flush(controller) {
								// Process any remaining data in the buffer
								if (buffer.length > 0 && buffer.startsWith('data: ')) {
									try {
										const trimmedData = buffer.substring(6).trim();
										if (trimmedData.length > 0 && trimmedData !== '[DONE]') {
											const jsonData = JSON.parse(trimmedData);
											const openaiChunkStr = transformGeminiStreamChunk(jsonData, requestedModelId!);
											if (openaiChunkStr) controller.enqueue(new TextEncoder().encode(openaiChunkStr));
										}
									} catch (e) {
										console.error("Error handling final stream buffer:", buffer, e);
										const errorMsg = `Error processing final stream chunk: ${e instanceof Error ? e.message : String(e)}`;
										const errorChunk = encodeOpenAiResponseChunk('content', requestedModelId!, { content: `[${errorMsg}]` });
										controller.enqueue(errorChunk);
									}
								}
								// Always send [DONE] at the end of a successful stream
								controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
								console.log("Standard stream finished.");
							}
						});
						// Pipe the *actual* Gemini stream through the transformer
						return new Response(geminiResponse.body.pipeThrough(transformer), { status: 200, headers: responseHeaders });
					}
					// --- NON-STREAMING MODE ---
					else if (!stream) {
						console.log("Processing successful response in NON-STREAMING mode.");
						const geminiJson = await geminiResponse.json();
						// Use the object transformation function
						// Pass requestedModelId (with -search if present) to transformer for correct display in client
						const openaiJsonObject = transformGeminiResponseToOpenAIObject(geminiJson, requestedModelId!);
						return new Response(JSON.stringify(openaiJsonObject), { status: 200, headers: responseHeaders });
					}
					// --- ERROR: STREAM EXPECTED BUT NO BODY ---
					else {
						console.error("Stream requested but Gemini response body is missing.");
						lastErrorBody = { error: "Gemini response body missing for stream" };
						lastErrorStatus = 500;
						break; // Exit loop
					}
				} // End geminiResponse.ok check

			} catch (fetchError) { // Catch errors *within* a single attempt
				// Catch network errors or other errors during fetch/key selection within an attempt
				console.error(`Attempt ${attempt}: Error during proxy call:`, fetchError);
				lastErrorBody = { error: { message: `Internal Worker Error during attempt ${attempt}: ${fetchError instanceof Error ? fetchError.message : String(fetchError)}`, type: 'worker_internal_error' } };
				lastErrorStatus = 500;
				break; // If a network error occurs, break the loop
			}
		} // --- End Retry Loop ---

		// If the loop finished, return the last recorded error.
		console.error(`All ${MAX_RETRIES} attempts failed or loop broken. Returning last recorded error (Status: ${lastErrorStatus}).`);
		return new Response(JSON.stringify(lastErrorBody), {
			status: lastErrorStatus,
			headers: { 'Content-Type': 'application/json', ...corsHeaders() }
		});

	} catch (initialError) {
		// Catch errors happening *before* the loop starts (e.g., getting initial config)
		console.error("Error before starting proxy attempts:", initialError);
		return new Response(JSON.stringify({ error: { message: `Internal Worker Error: ${initialError instanceof Error ? initialError.message : String(initialError)}`, type: 'worker_setup_error' } }), {
			status: 500,
			headers: { 'Content-Type': 'application/json', ...corsHeaders() }
		});
	}
}

async function handleV1Models(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	console.log("Handling /v1/models");
	try {
		// Fetch models from WORKER_CONFIG_KV
		const config = await env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json") as Record<string, ModelConfig> | null;
		let modelsData: Array<{id: string, object: string, created: number, owned_by: string}> = [];
		if (config && Object.keys(config).length > 0) {
			modelsData = Object.keys(config).map(modelId => ({
				id: modelId,
				object: "model",
				created: Math.floor(Date.now() / 1000),
				owned_by: "google",
			}));

			// Add search versions for gemini-2.0+ series models
			const searchModels = Object.keys(config)
				.filter(modelId =>
					// Match gemini-2.0, gemini-2.5, gemini-3.0, etc. series models
					/^gemini-[2-9]\.\d/.test(modelId) &&
					// Exclude models that are already search versions
					!modelId.endsWith('-search')
				)
				.map(modelId => ({
					id: `${modelId}-search`,
					object: "model",
					created: Math.floor(Date.now() / 1000),
					owned_by: "google",
				}));

			// Merge the list of regular models and search models
			modelsData = [...modelsData, ...searchModels];
		} else {
			console.log("No models found in WORKER_CONFIG_KV, returning empty list.");
		}

		return new Response(JSON.stringify({ object: "list", data: modelsData }), {
			headers: { 'Content-Type': 'application/json', ...corsHeaders() }
		});
	} catch (e) {
		console.error("Error fetching models from KV:", e);
		return new Response(JSON.stringify({ error: "Failed to retrieve models" }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
	}
}

// --- Admin API Handler ---
async function handleAdminGeminiModels(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for gemini-models` }),
      { status: 405, headers: { ...headers, 'Allow': 'GET' } });
  }

  // First check if there are any available Gemini API Keys
  const selectedKey = await getNextAvailableGeminiKey(env, ctx, undefined);
  if (!selectedKey) {
    // No available keys, return empty array
    return new Response(JSON.stringify([]), { headers });
  }

  // Use the available key to request Gemini models list
  try {
    // Corrected URL and authentication method (using ?key= query parameter)
  const BASE_GEMINI_URL = getBaseGeminiUrl(env); // Get dynamic base URL
    const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models?key=${selectedKey.key}`;
    const response = await fetch(geminiUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        // Removed Authorization header
      }
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Error fetching Gemini models: ${response.status} ${response.statusText}`, errorBody);
      // Return empty array on error, as before
      return new Response(JSON.stringify([]), { headers });
    }

    const data = await response.json();
    // Process response - the structure is { models: [...] } as confirmed by user feedback
    const processedModels = (data.models || []).map((model: any) => {
      // Extract the model ID after "models/"
      const modelId = model.name?.startsWith('models/') ? model.name.substring(7) : model.name;
      return {
        id: modelId, // Use the extracted ID
        object: 'model',
        owned_by: 'google' // Assuming all are Google models
      };
    });

    return new Response(JSON.stringify(processedModels), { headers });
  } catch (error) {
    console.error('Error fetching Gemini models:', error);
    return new Response(JSON.stringify([]), { headers });
  }
}

async function handleAdminApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const pathSegments = url.pathname.split('/').filter(Boolean); // e.g., ['api', 'admin', 'gemini-keys']

	if (pathSegments.length < 3) {
		return new Response(JSON.stringify({ error: "Invalid admin API path" }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
	}

	const resource = pathSegments[2];
	const resourceId = pathSegments[3];

	try {
		switch (resource) {
			case 'gemini-keys':
				return await handleAdminGeminiKeys(request, env, ctx, resourceId);
			case 'worker-keys':
				return await handleAdminWorkerKeys(request, env, ctx, resourceId);
			case 'models':
				return await handleAdminModels(request, env, ctx, resourceId);
			case 'category-quotas':
				return await handleAdminCategoryQuotas(request, env, ctx);
			case 'test-gemini-key':
				return await handleTestGeminiKey(request, env, ctx);
			case 'gemini-models':
				return await handleAdminGeminiModels(request, env, ctx);
			case 'error-keys': // New route to get keys with errors
				return await handleAdminGetErrorKeys(request, env, ctx);
			case 'clear-key-error': // New route to clear a key's error
				return await handleAdminClearKeyError(request, env, ctx);
			default:
				return new Response(JSON.stringify({ error: "Unknown admin resource" }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
		}
	} catch (error) {
		console.error(`Error handling admin API for ${resource}:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
	}
}

async function handleTestGeminiKey(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for test-gemini-key` }),
			{ status: 405, headers: { ...headers, 'Allow': 'POST' } });
	}

	const body = await readRequestBody<{ keyId: string, modelId: string }>(request);
	if (!body || !body.keyId || !body.modelId) {
		return new Response(JSON.stringify({ error: 'Request body must include keyId and modelId' }),
			{ status: 400, headers });
	}

	const keyKvName = `key:${body.keyId}`;
	const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
	if (!keyInfoJson) {
		return new Response(JSON.stringify({ error: `API Key with ID '${body.keyId}' not found.` }),
			{ status: 404, headers });
	}

	try {
		const keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
		const apiKey = keyInfoData.key;
		if (!apiKey) {
			return new Response(JSON.stringify({ error: 'Invalid API key data stored.' }),
				{ status: 500, headers });
		}

		// Fetch model category to pass to incrementKeyUsage
		const modelsConfig = await env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json") as Record<string, ModelConfig> | null;
		const modelCategory = modelsConfig?.[body.modelId]?.category;

		const testGeminiRequestBody = {
			contents: [{ role: "user", parts: [{ text: "Hi" }] }],
		};
const BASE_GEMINI_URL = getBaseGeminiUrl(env); // Get dynamic base URL
const geminiUrl = `${BASE_GEMINI_URL}/v1beta/models/${body.modelId}:generateContent?key=${apiKey}`;

		const response = await fetch(geminiUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(testGeminiRequestBody)
		});

		let responseContent = '';
		let responseJson: any = null;
		try {
			responseJson = await response.json();
			responseContent = JSON.stringify(responseJson);
		} catch (e) {
			try {
				responseContent = await response.text();
			} catch (textError) {
				responseContent = 'Failed to parse or read response';
			}
		}

		if (response.ok) {
			ctx.waitUntil(incrementKeyUsage(body.keyId, env, body.modelId, modelCategory));
		} else {
			// --- New: Record 401/403 errors during test ---
			if (response.status === 401 || response.status === 403) {
				console.warn(`Received ${response.status} during test for key ${body.keyId}. Recording error status.`);
				ctx.waitUntil(recordKeyError(body.keyId, env, response.status as 401 | 403));
			}
			// --- End New Error Recording ---
		}


		return new Response(JSON.stringify({
			success: response.ok,
			status: response.status,
			content: responseJson ?? responseContent
		}), { headers });

	} catch (error) {
		console.error(`Error testing Gemini API key:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}

// --- Admin API Resource Handlers ---

// New handler to get keys with errors
async function handleAdminGetErrorKeys(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };
	if (request.method !== 'GET') {
		return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for error-keys` }),
			{ status: 405, headers: { ...headers, 'Allow': 'GET' } });
	}

	try {
		const listResult = await env.GEMINI_KEYS_KV.list({ prefix: 'key:' });
		const errorKeyPromises = listResult.keys.map(async (keyMeta) => {
			const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyMeta.name);
			if (!keyInfoJson) return null;
			try {
				const keyInfoData = JSON.parse(keyInfoJson) as Partial<GeminiKeyInfo>;
				if (keyInfoData.errorStatus === 401 || keyInfoData.errorStatus === 403) {
					const keyId = keyMeta.name.replace('key:', '');
					return {
						id: keyId,
						name: keyInfoData.name || keyId,
						error: keyInfoData.errorStatus,
					};
				}
				return null;
			} catch (e) {
				console.error(`Error processing error status for key ${keyMeta.name}:`, e);
				return null;
			}
		});

		const errorKeys = (await Promise.all(errorKeyPromises)).filter(k => k !== null);
		return new Response(JSON.stringify(errorKeys), { headers });

	} catch (error) {
		console.error(`Error handling admin API for Error Keys:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}

// New handler to clear a key's error status
async function handleAdminClearKeyError(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };
	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for clear-key-error` }),
			{ status: 405, headers: { ...headers, 'Allow': 'POST' } });
	}

	const body = await readRequestBody<{ keyId: string }>(request);
	if (!body || typeof body.keyId !== 'string' || body.keyId.trim() === '') {
		return new Response(JSON.stringify({ error: 'Request body must include a valid non-empty string: keyId' }), { status: 400, headers });
	}

	const keyIdToClear = body.keyId.trim();
	const keyKvName = `key:${keyIdToClear}`;

	try {
		const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
		if (!keyInfoJson) {
			return new Response(JSON.stringify({ error: `Key with ID '${keyIdToClear}' not found.` }), { status: 404, headers });
		}

		let keyInfoData = JSON.parse(keyInfoJson) as Partial<GeminiKeyInfo>;

		if (keyInfoData.errorStatus === null || keyInfoData.errorStatus === undefined) {
			// No error to clear, but still return success
			return new Response(JSON.stringify({ success: true, id: keyIdToClear, message: "No error status to clear." }), { headers });
		}

		// Clear the error status
		keyInfoData.errorStatus = null;

		// Save back to KV
		await env.GEMINI_KEYS_KV.put(keyKvName, JSON.stringify(keyInfoData));
		console.log(`Cleared error status for key ${keyIdToClear}.`);

		return new Response(JSON.stringify({ success: true, id: keyIdToClear }), { headers });

	} catch (error) {
		console.error(`Error clearing error status for key ${keyIdToClear}:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}


async function handleAdminGeminiKeys(request: Request, env: Env, ctx: ExecutionContext, resourceId?: string): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

	try {
		switch (request.method) {
			case 'GET': {
				// Fetch models config and category quotas in parallel
				const [modelsConfigJson, categoryQuotasJson] = await Promise.all([
					env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json"),
					env.WORKER_CONFIG_KV.get(KV_KEY_CATEGORY_QUOTAS, "json")
				]);
				const modelsConfig: Record<string, ModelConfig> = (modelsConfigJson as Record<string, ModelConfig>) || {};
				const categoryQuotas: CategoryQuotas = (categoryQuotasJson as CategoryQuotas) || { proQuota: Infinity, flashQuota: Infinity };

				// List all Gemini keys with their current usage
				const listResult = await env.GEMINI_KEYS_KV.list({ prefix: 'key:' });
				const keyPromises = listResult.keys.map(async (keyMeta) => {
					const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyMeta.name);
					if (!keyInfoJson) return null;
					try {
						const keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
						const keyId = keyMeta.name.replace('key:', '');
						const todayInLA = getTodayInLA();
						const isQuotaReset = keyInfoData.usageDate !== todayInLA;

						let modelUsageData: Record<string, { count: number; quota?: number }> = {};
						let categoryUsageData = { pro: 0, flash: 0 };

						// Populate modelUsageData for all relevant models (Custom or Pro/Flash with individualQuota)
						Object.entries(modelsConfig).forEach(([modelId, modelConfig]) => {
							let quota: number | undefined = undefined;
							let shouldInclude = false;

							if (modelConfig.category === 'Custom') {
								quota = modelConfig.dailyQuota;
								shouldInclude = true; // Always include Custom models
							} else if ((modelConfig.category === 'Pro' || modelConfig.category === 'Flash') && modelConfig.individualQuota) {
								quota = modelConfig.individualQuota;
								shouldInclude = true; // Include Pro/Flash if they have individualQuota
							}

							if (shouldInclude) {
								const count = isQuotaReset 
									? 0 
									: (keyInfoData.modelUsage?.[modelId] ?? 0);
								
								modelUsageData[modelId] = {
									count: typeof count === 'number' ? count : 0, // Ensure count is a number
									quota: quota
								};
							}
						});
						
						// Populate categoryUsageData
						categoryUsageData = isQuotaReset 
							? { pro: 0, flash: 0 } 
							: (keyInfoData.categoryUsage || { pro: 0, flash: 0 });


						return {
							id: keyId,
							name: keyInfoData.name || keyId,
							keyPreview: `...${(keyInfoData.key || '').slice(-4)}`,
							usage: keyInfoData.usageDate === todayInLA ? (keyInfoData.usage || 0) : 0,
							usageDate: keyInfoData.usageDate || 'N/A',
							modelUsage: modelUsageData, 
							categoryUsage: categoryUsageData,
							categoryQuotas: categoryQuotas,
							errorStatus: keyInfoData.errorStatus, // Include error status
							consecutive429Counts: keyInfoData.consecutive429Counts || {} // Include 429 counts
						};
					} catch (e) {
						console.error(`Error processing key ${keyMeta.name}:`, e);
						return null;
					}
				});
				const keys = (await Promise.all(keyPromises)).filter(k => k !== null);
				return new Response(JSON.stringify(keys), { headers });
			}

			case 'POST': {
				// Add a new Gemini key
				const body = await readRequestBody<Partial<Omit<GeminiKeyInfo, 'id'>>>(request);
				if (!body || typeof body.key !== 'string' || body.key.trim() === '') {
					return new Response(JSON.stringify({ error: 'Request body must include a valid API key' }), { status: 400, headers });
				}

				const listResult = await env.GEMINI_KEYS_KV.list({ prefix: 'key:' });
				for (const keyMeta of listResult.keys) {
					const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyMeta.name);
					if (keyInfoJson) {
						try {
							const keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
							if (keyInfoData.key === body.key.trim()) {
								return new Response(JSON.stringify({ 
									error: 'Cannot add duplicate API key',
									details: 'The API key already exists in the system'
								}), { status: 409, headers });
							}
						} catch (e) {
							console.error(`Error checking for duplicate key (${keyMeta.name}):`, e);
						}
					}
				}

				const timestamp = Date.now();
				const randomString = Math.random().toString(36).substring(2, 8);
				const keyId = `gk-${timestamp}-${randomString}`;
				const keyKvName = `key:${keyId}`;
				const keyName = (typeof body.name === 'string' && body.name.trim()) ? body.name.trim() : keyId;
				const newKeyInfo: Omit<GeminiKeyInfo, 'id'> = {
					key: body.key.trim(),
					usage: 0,
					usageDate: '', 
					name: keyName,
					modelUsage: {},
					categoryUsage: { pro: 0, flash: 0 },
					errorStatus: null, // Initialize error status
					consecutive429Counts: {} // Initialize 429 counts
				};

				await env.GEMINI_KEYS_KV.put(keyKvName, JSON.stringify(newKeyInfo));

				ctx.waitUntil((async () => {
					const listJson = await env.GEMINI_KEYS_KV.get(KV_KEY_GEMINI_KEY_LIST);
					const keyList: string[] = listJson ? JSON.parse(listJson) : [];
					keyList.push(keyId);
					await env.GEMINI_KEYS_KV.put(KV_KEY_GEMINI_KEY_LIST, JSON.stringify(keyList));
					console.log(`Added key ${keyId} to rotation list.`);
				})());

				return new Response(JSON.stringify({ success: true, id: keyId, name: keyName }), { status: 201, headers });
			}

			case 'DELETE': {
				// Delete a Gemini key
				if (!resourceId) {
					return new Response(JSON.stringify({ error: 'Missing key ID in path (/api/admin/gemini-keys/:id)' }), { status: 400, headers });
				}
				const keyIdToDelete = resourceId.trim();
				const keyKvName = `key:${keyIdToDelete}`;

				// Check if key exists before deleting
				if (await env.GEMINI_KEYS_KV.get(keyKvName) === null) {
					return new Response(JSON.stringify({ error: `Key with ID '${keyIdToDelete}' not found.` }), { status: 404, headers });
				}

				// Delete key info from KV
				await env.GEMINI_KEYS_KV.delete(keyKvName);

				// Remove key ID from the list (run in background)
				ctx.waitUntil((async () => {
					const listJson = await env.GEMINI_KEYS_KV.get(KV_KEY_GEMINI_KEY_LIST);
					let keyList: string[] = listJson ? JSON.parse(listJson) : [];
					const initialLength = keyList.length;
					keyList = keyList.filter(id => id !== keyIdToDelete);

					if (keyList.length < initialLength) {
						await env.GEMINI_KEYS_KV.put(KV_KEY_GEMINI_KEY_LIST, JSON.stringify(keyList));
						console.log(`Removed key ${keyIdToDelete} from rotation list.`);
						const indexStr = await env.GEMINI_KEYS_KV.get(KV_KEY_GEMINI_KEY_INDEX);
						let currentIndex = indexStr ? parseInt(indexStr, 10) : 0;
						if (currentIndex >= keyList.length && keyList.length > 0) {
							await env.GEMINI_KEYS_KV.put(KV_KEY_GEMINI_KEY_INDEX, "0");
						} else if (keyList.length === 0) {
							await env.GEMINI_KEYS_KV.delete(KV_KEY_GEMINI_KEY_INDEX);
						}
					}
				})());

				return new Response(JSON.stringify({ success: true, id: keyIdToDelete }), { headers });
			}

			default:
				return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for /api/admin/gemini-keys` }), { status: 405, headers: { ...headers, 'Allow': 'GET, POST, DELETE' } });
		}
	} catch (error) {
		console.error(`Error handling admin API for Gemini Keys:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}

async function handleWorkerKeySafetySettings(request: Request, env: Env): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for safety-settings` }),
			{ status: 405, headers: { ...headers, 'Allow': 'POST' } });
	}

	const body = await readRequestBody<{ key: string; safetyEnabled: boolean }>(request);
	if (!body || typeof body.key !== 'string' || body.key.trim() === '' || typeof body.safetyEnabled !== 'boolean') {
		return new Response(JSON.stringify({ error: 'Invalid request body. Must include key (string) and safetyEnabled (boolean).' }),
			{ status: 400, headers });
	}

	const workerKey = body.key.trim();
	const safetyEnabled = body.safetyEnabled;

	try {
		const keysConfig = await env.WORKER_CONFIG_KV.get(KV_KEY_WORKER_KEYS, "json") as Record<string, any> | null;
		if (!keysConfig || !keysConfig.hasOwnProperty(workerKey)) {
			return new Response(JSON.stringify({ error: `Worker key '${workerKey}' not found.` }),
				{ status: 404, headers });
		}

		const safetySettingsJson = await env.WORKER_CONFIG_KV.get(KV_KEY_WORKER_KEYS_SAFETY);
		let safetySettings: Record<string, { safetyEnabled: boolean }> = safetySettingsJson ? JSON.parse(safetySettingsJson) : {};

		safetySettings[workerKey] = { safetyEnabled };

		await env.WORKER_CONFIG_KV.put(KV_KEY_WORKER_KEYS_SAFETY, JSON.stringify(safetySettings));

		return new Response(JSON.stringify({
			success: true,
			key: workerKey,
			safetyEnabled: safetyEnabled
		}), { headers });

	} catch (error) {
		console.error(`Error saving worker key safety settings:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}

async function handleAdminWorkerKeys(request: Request, env: Env, ctx: ExecutionContext, resourceId?: string): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

	try {
		if (resourceId === 'safety-settings') {
			return await handleWorkerKeySafetySettings(request, env);
		}

		const keysConfigJson = await env.WORKER_CONFIG_KV.get(KV_KEY_WORKER_KEYS);
		let keysConfig: Record<string, { description?: string; createdAt: string }> = keysConfigJson ? JSON.parse(keysConfigJson) : {};

		switch (request.method) {
			case 'GET': {
				// Fetch safety settings as well
				const safetySettingsJson = await env.WORKER_CONFIG_KV.get(KV_KEY_WORKER_KEYS_SAFETY);
				let safetySettings: Record<string, { safetyEnabled: boolean }> = {};
				try {
					if (safetySettingsJson) {
						safetySettings = JSON.parse(safetySettingsJson);
					}
				} catch (e) {
					console.error("Error parsing safety settings in GET /worker-keys:", e);
				}

				const keyList = Object.entries(keysConfig).map(([key, data]) => {
					const isSafetyEnabled = safetySettings[key]?.safetyEnabled ?? true;
					return {
						key: key,
						description: data.description || '',
						createdAt: data.createdAt || 'N/A',
						safetyEnabled: isSafetyEnabled,
					};
				});
				return new Response(JSON.stringify(keyList), { headers });
			}

			case 'POST': {
				const body = await readRequestBody<{ key: string; description?: string }>(request);
				if (!body || typeof body.key !== 'string' || body.key.trim() === '') {
					return new Response(JSON.stringify({ error: 'Request body must include a valid non-empty string: key' }), { status: 400, headers });
				}
				const newKey = body.key.trim();
				if (keysConfig.hasOwnProperty(newKey)) {
					return new Response(JSON.stringify({ error: `Worker key '${newKey}' already exists.` }), { status: 409, headers });
				}

				keysConfig[newKey] = {
					description: typeof body.description === 'string' ? body.description.trim() : '',
					createdAt: new Date().toISOString(),
				};

				await env.WORKER_CONFIG_KV.put(KV_KEY_WORKER_KEYS, JSON.stringify(keysConfig));
				return new Response(JSON.stringify({ success: true, key: newKey }), { status: 201, headers });
			}

			case 'DELETE': {
				// Delete a worker key (using the key itself as resourceId)
				if (!resourceId) {
					const url = new URL(request.url);
					resourceId = url.searchParams.get('key') || undefined;
					if (!resourceId) {
						return new Response(JSON.stringify({ error: 'Missing worker key in path (/api/admin/worker-keys/:key) or query param (?key=...)' }), { status: 400, headers });
					}
				}
				const keyToDelete = resourceId.trim();


				if (!keysConfig.hasOwnProperty(keyToDelete)) {
					return new Response(JSON.stringify({ error: `Worker key '${keyToDelete}' not found.` }), { status: 404, headers });
				}

				delete keysConfig[keyToDelete];
				await env.WORKER_CONFIG_KV.put(KV_KEY_WORKER_KEYS, JSON.stringify(keysConfig));
				return new Response(JSON.stringify({ success: true, key: keyToDelete }), { headers });
			}

			default:
				return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for Worker Keys` }), { status: 405, headers: { ...headers, 'Allow': 'GET, POST, DELETE' } });
		}
	} catch (error) {
		console.error(`Error handling admin API for Worker Keys:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}

async function handleAdminModels(request: Request, env: Env, ctx: ExecutionContext, resourceId?: string): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

	try {
		// Fetch the current models object (or initialize if null)
		const modelsConfigJson = await env.WORKER_CONFIG_KV.get(KV_KEY_MODELS);
		let modelsConfig: Record<string, ModelConfig> = modelsConfigJson ? JSON.parse(modelsConfigJson) : {};

		switch (request.method) {
			case 'GET': {
				const modelList = Object.entries(modelsConfig).map(([id, data]) => ({
					id: id,
					category: data.category,
					dailyQuota: data.dailyQuota,
					individualQuota: data.individualQuota
				}));
				return new Response(JSON.stringify(modelList), { headers });
			}

			case 'POST': {
				// Add or update a model with category
				const body = await readRequestBody<{ 
					id: string; 
					category: 'Pro' | 'Flash' | 'Custom'; 
					dailyQuota?: number | string;
					individualQuota?: number;
				}>(request);
				
				if (!body || typeof body.id !== 'string' || body.id.trim() === '') {
					return new Response(JSON.stringify({ error: 'Request body must include a valid non-empty string: id' }), { status: 400, headers });
				}
				if (!body.category || !['Pro', 'Flash', 'Custom'].includes(body.category)) {
					return new Response(JSON.stringify({ error: 'Request body must include a valid category: Pro, Flash, or Custom' }), { status: 400, headers });
				}
				const modelId = body.id.trim();
				const category = body.category;

				// Process the dailyQuota (mainly for Custom models)
				let newQuota: number | undefined = undefined;
				if (category === 'Custom') {
					if (body.dailyQuota !== undefined && body.dailyQuota !== null && body.dailyQuota !== '') {
						const quotaInput = String(body.dailyQuota).trim().toLowerCase();
						if (quotaInput === 'none' || quotaInput === '0') {
							newQuota = undefined; // Treat 'none' or '0' as unlimited (undefined)
						} else {
							const parsedQuota = parseInt(quotaInput, 10);
							if (!isNaN(parsedQuota) && parsedQuota > 0 && quotaInput === parsedQuota.toString()) {
								newQuota = parsedQuota;
							} else {
								return new Response(JSON.stringify({ error: "Daily Quota for Custom models must be a positive whole number, 'none', or '0'." }), { status: 400, headers });
							}
						}
					}
				}

				// Process the individualQuota (for Pro and Flash models)
				let individualQuota: number | undefined = undefined;
				if ((category === 'Pro' || category === 'Flash') && body.individualQuota !== undefined) {
					if (typeof body.individualQuota === 'number' && body.individualQuota > 0) {
						individualQuota = body.individualQuota;
					}
				}

				// Check if this is an update or a new model
				const isUpdate = modelsConfig.hasOwnProperty(modelId);
				
				// Create or update the model
				modelsConfig[modelId] = { 
					category: category, 
					dailyQuota: newQuota, 
					individualQuota: individualQuota 
				};

				// Save to KV store
				await env.WORKER_CONFIG_KV.put(KV_KEY_MODELS, JSON.stringify(modelsConfig));
				
				return new Response(JSON.stringify({ 
					success: true, 
					id: modelId, 
					category: category, 
					dailyQuota: newQuota,
					individualQuota: individualQuota 
				}), { status: isUpdate ? 200 : 201, headers });
			}

			case 'DELETE': {
				// Delete a model
				if (!resourceId) {
					const url = new URL(request.url);
					resourceId = url.searchParams.get('id') || undefined;
					if (!resourceId) {
						return new Response(JSON.stringify({ error: 'Missing model ID in path (/api/admin/models/:id) or query param (?id=...)' }), { status: 400, headers });
					}
				}
				const modelIdToDelete = decodeURIComponent(resourceId.trim());

				if (!modelsConfig.hasOwnProperty(modelIdToDelete)) {
					return new Response(JSON.stringify({ error: `Model '${modelIdToDelete}' not found.` }), { status: 404, headers });
				}

				delete modelsConfig[modelIdToDelete];
				await env.WORKER_CONFIG_KV.put(KV_KEY_MODELS, JSON.stringify(modelsConfig));
				return new Response(JSON.stringify({ success: true, id: modelIdToDelete }), { headers });
			}

			default:
				return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for Models` }), { status: 405, headers: { ...headers, 'Allow': 'GET, POST, DELETE' } });
		}
	} catch (error) {
		console.error(`Error handling admin API for Models:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}

// New handler for category quotas
async function handleAdminCategoryQuotas(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };

	try {
		switch (request.method) {
			case 'GET': {
				const quotasJson = await env.WORKER_CONFIG_KV.get(KV_KEY_CATEGORY_QUOTAS);
				const quotas: CategoryQuotas = quotasJson ? JSON.parse(quotasJson) : { proQuota: 50, flashQuota: 1500 }; // Default quotas
				return new Response(JSON.stringify(quotas), { headers });
			}
			case 'POST': {
				const body = await readRequestBody<Partial<CategoryQuotas>>(request);
				if (!body || typeof body.proQuota !== 'number' || typeof body.flashQuota !== 'number' || body.proQuota < 0 || body.flashQuota < 0) {
					return new Response(JSON.stringify({ error: 'Request body must include valid non-negative numbers for proQuota and flashQuota' }), { status: 400, headers });
				}

				const newQuotas: CategoryQuotas = {
					proQuota: Math.floor(body.proQuota),
					flashQuota: Math.floor(body.flashQuota) 
				};

				await env.WORKER_CONFIG_KV.put(KV_KEY_CATEGORY_QUOTAS, JSON.stringify(newQuotas));
				return new Response(JSON.stringify({ success: true, ...newQuotas }), { headers });
			}
			default:
				return new Response(JSON.stringify({ error: `Method ${request.method} not allowed for Category Quotas` }), { status: 405, headers: { ...headers, 'Allow': 'GET, POST' } });
		}
	} catch (error) {
		console.error(`Error handling admin API for Category Quotas:`, error);
		const errorMessage = error instanceof Error ? error.message : 'Internal Server Error';
		return new Response(JSON.stringify({ error: errorMessage }), { status: 500, headers });
	}
}


// --- Worker API Key Validation ---

async function isValidWorkerApiKey(apiKey: string, env: Env): Promise<boolean> {
	if (!apiKey) return false;
	try {
		const keysConfig = await env.WORKER_CONFIG_KV.get(KV_KEY_WORKER_KEYS, "json") as Record<string, any> | null;
		return keysConfig ? keysConfig.hasOwnProperty(apiKey) : false;
	} catch (e) {
		console.error("Error validating worker API key:", e);
		return false;
	}
}


// --- Session Management & Authentication ---

/**
 * Encodes data using TextEncoder.
 */
function encode(data: string): Uint8Array {
	const encoder = new TextEncoder();
	return encoder.encode(data);
}

/**
 * Decodes data using TextDecoder.
 */
function decode(data: Uint8Array): string {
	const decoder = new TextDecoder();
	return decoder.decode(data);
}

/**
 * Converts ArrayBuffer to Base64 URL safe string.
 */
function bufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	bytes.forEach((byte) => {
		binary += String.fromCharCode(byte);
	});
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Converts Base64 URL safe string to ArrayBuffer.
 */
function base64UrlToBuffer(base64url: string): ArrayBuffer {
	base64url = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const padding = base64url.length % 4;
	if (padding) {
		base64url += '='.repeat(4 - padding);
	}
	const binary = atob(base64url);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes.buffer;
}


/**
 * Generates a signed session token (simple structure, not full JWT).
 * Payload: { exp: number }
 */
async function generateSessionToken(env: Env): Promise<string | null> {
	if (!env.SESSION_SECRET_KEY) {
		console.error("SESSION_SECRET_KEY is not set. Cannot generate session token.");
		return null;
	}
	try {
		const expiration = Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS;
		const payload = JSON.stringify({ exp: expiration });
		const encodedPayload = bufferToBase64Url(encode(payload));

		const key = await crypto.subtle.importKey(
			'raw',
			encode(env.SESSION_SECRET_KEY),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const signature = await crypto.subtle.sign('HMAC', key, encode(encodedPayload));
		const encodedSignature = bufferToBase64Url(signature);

		return `${encodedPayload}.${encodedSignature}`;
	} catch (e) {
		console.error("Error generating session token:", e);
		return null;
	}
}

/**
 * Verifies the signature and expiration of a session token.
 */
async function verifySessionToken(token: string, env: Env): Promise<boolean> {
	if (!env.SESSION_SECRET_KEY) {
		console.error("SESSION_SECRET_KEY is not set. Cannot verify session token.");
		return false;
	}
	try {
		const parts = token.split('.');
		if (parts.length !== 2) return false;

		const [encodedPayload, encodedSignature] = parts;
		const signature = base64UrlToBuffer(encodedSignature);

		const key = await crypto.subtle.importKey(
			'raw',
			encode(env.SESSION_SECRET_KEY),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['verify']
		);

		// Convert signature ArrayBuffer to Uint8Array for verify function
		const isValid = await crypto.subtle.verify('HMAC', key, new Uint8Array(signature), encode(encodedPayload));
		if (!isValid) return false;

		// Convert the ArrayBuffer from base64UrlToBuffer to Uint8Array for decode
		const payloadJson = decode(new Uint8Array(base64UrlToBuffer(encodedPayload)));
		const payload = JSON.parse(payloadJson);

		// Check expiration
		const now = Math.floor(Date.now() / 1000);
		return payload.exp > now;

	} catch (e) {
		console.error("Error verifying session token:", e);
		return false;
	}
}

/**
 * Extracts the session token from the request's Cookie header.
 */
function getSessionTokenFromCookie(request: Request): string | null {
	const cookieHeader = request.headers.get('Cookie');
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(';');
	for (const cookie of cookies) {
		const [name, value] = cookie.trim().split('=');
		if (name === SESSION_COOKIE_NAME) {
			return decodeURIComponent(value);
		}
	}
	return null;
}

/**
 * Creates the Set-Cookie header string for the session.
 */
function createSessionCookie(token: string): string {
	const expires = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);
	return `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Expires=${expires.toUTCString()}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Creates the Set-Cookie header string to clear the session cookie.
 */
function clearSessionCookie(): string {
	return `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Verifies the session cookie from the request.
 */
async function verifySessionCookie(request: Request, env: Env): Promise<boolean> {
	const token = getSessionTokenFromCookie(request);
	if (!token) return false;
	return await verifySessionToken(token, env);
}

/**
 * Middleware factory to protect routes.
 */
function createAuthMiddleware(env: Env) {
	return async function requireAuth(request: Request, handler: () => Promise<Response>): Promise<Response> {
		const url = new URL(request.url);
		const isAuthenticated = await verifySessionCookie(request, env);

		if (!isAuthenticated) {
			const loginUrl = new URL(url.origin + '/login');
			return Response.redirect(loginUrl.toString(), 302);
		}

		return await handler();
	}
}

// --- Login/Logout Handlers ---

async function handleLoginRequest(request: Request, env: Env): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...corsHeaders() };
	if (!env.ADMIN_PASSWORD) {
		console.error("ADMIN_PASSWORD is not set. Cannot process login.");
		return new Response(JSON.stringify({ error: 'Server configuration error: Admin password not set.' }), { status: 500, headers });
	}
	if (!env.SESSION_SECRET_KEY) {
		console.error("SESSION_SECRET_KEY is not set. Cannot process login.");
		return new Response(JSON.stringify({ error: 'Server configuration error: Session secret not set.' }), { status: 500, headers });
	}

	try {
		const body = await readRequestBody<{ password?: string }>(request);
		if (!body || typeof body.password !== 'string') {
			return new Response(JSON.stringify({ error: 'Password is required.' }), { status: 400, headers });
		}

		if (body.password === env.ADMIN_PASSWORD) {
			const token = await generateSessionToken(env);
			if (!token) {
				return new Response(JSON.stringify({ error: 'Failed to generate session token.' }), { status: 500, headers });
			}
			const cookieHeader = createSessionCookie(token);
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { ...headers, 'Set-Cookie': cookieHeader }
			});
		} else {
			return new Response(JSON.stringify({ error: 'Invalid password.' }), { status: 401, headers });
		}
	} catch (error) {
		console.error("Error during login:", error);
		return new Response(JSON.stringify({ error: 'An internal error occurred during login.' }), { status: 500, headers });
	}
}

function handleLogoutRequest(): Response {
	// Clear the session cookie
	const cookieHeader = clearSessionCookie();
	return new Response(null, {
		status: 302,
		headers: {
			'Set-Cookie': cookieHeader,
			'Location': '/login'
		}
	});
}


// --- Gemini Key Management ---

/**
 * Selects the next available Gemini API key using a sequential round-robin approach,
 * ensuring fair distribution of requests across all available keys.
 * Automatically skips keys with 401/403 errors or quota limitations.
 * Quota checking for the selected key is done in handleV1ChatCompletions.
 */
async function getNextAvailableGeminiKey(env: Env, ctx: ExecutionContext, requestedModelId?: string): Promise<{ id: string; key: string } | null> {
	try {
		// 1. Get the full list of configured key IDs
		const keyListJson = await env.GEMINI_KEYS_KV.get(KV_KEY_GEMINI_KEY_LIST);
		const allKeyIds: string[] = keyListJson ? JSON.parse(keyListJson) : [];

		if (allKeyIds.length === 0) {
			console.error("No Gemini keys configured in KV under", KV_KEY_GEMINI_KEY_LIST);
			return null;
		}

		// 2. Get the current index (for round-robin selection)
		const currentIndexStr = await env.GEMINI_KEYS_KV.get(KV_KEY_GEMINI_KEY_INDEX);
		let currentIndex = 0;
		if (currentIndexStr) {
			try {
				currentIndex = parseInt(currentIndexStr, 10);
				// Ensure the index is valid (in case the key list changed)
				if (isNaN(currentIndex) || currentIndex < 0 || currentIndex >= allKeyIds.length) {
					currentIndex = 0;
				}
			} catch (e) {
				console.error("Error parsing current index, resetting to 0:", e);
				currentIndex = 0;
			}
		}

		// 3. Get models and quotas config for checking quota limits
		const [modelsConfigJson, categoryQuotasJson] = await Promise.all([
			env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json"),
			env.WORKER_CONFIG_KV.get(KV_KEY_CATEGORY_QUOTAS, "json")
		]);
		const modelsConfig: Record<string, ModelConfig> = (modelsConfigJson as Record<string, ModelConfig>) || {};
		const categoryQuotas: CategoryQuotas = (categoryQuotasJson as CategoryQuotas) || { proQuota: Infinity, flashQuota: Infinity };
		
		// Get model category if model ID is provided
		let modelCategory: 'Pro' | 'Flash' | 'Custom' | undefined = undefined;
		if (requestedModelId) {
			modelCategory = modelsConfig[requestedModelId]?.category;
		}

		// 4. Try to find a valid key using round-robin
		const todayInLA = getTodayInLA(); // For quota checks
		let selectedKeyId: string | null = null;
		let selectedKeyValue: string | null = null;
		let keysChecked = 0;

		// Loop through keys starting from current index, wrapping around if needed
		while (keysChecked < allKeyIds.length) {
			// Get the key ID at the current position
			const keyId = allKeyIds[currentIndex];
			const keyKvName = `key:${keyId}`;
			const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);

			// Move to the next index for the next iteration (with wrapping)
			currentIndex = (currentIndex + 1) % allKeyIds.length;
			keysChecked++;

			// Skip if key info doesn't exist
			if (!keyInfoJson) continue;

			try {
				const keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
				
				// Check for error status (401/403)
				if (keyInfoData.errorStatus === 401 || keyInfoData.errorStatus === 403) {
					console.log(`Skipping key ${keyId} due to error status: ${keyInfoData.errorStatus}`);
					continue;
				}

				// Check for quota limitations if we have a model category
				if (modelCategory && keyInfoData.usageDate === todayInLA) {
					let quotaExceeded = false;

					// Check category quotas
					if (modelCategory === 'Pro') {
						const proLimit = categoryQuotas.proQuota ?? Infinity;
						const proUsage = keyInfoData.categoryUsage?.pro ?? 0;
						if (proUsage >= proLimit) {
							console.log(`Skipping key ${keyId}: Pro category quota reached (${proUsage}/${proLimit})`);
							quotaExceeded = true;
						}
						// Also check individual model quota if set
						else if (requestedModelId && modelsConfig[requestedModelId]?.individualQuota) {
							const modelLimit = modelsConfig[requestedModelId].individualQuota!;
							const modelUsage = keyInfoData.modelUsage?.[requestedModelId] ?? 0;
							if (modelUsage >= modelLimit) {
								console.log(`Skipping key ${keyId}: Pro model '${requestedModelId}' individual quota reached (${modelUsage}/${modelLimit})`);
								quotaExceeded = true;
							}
						}
					} 
					else if (modelCategory === 'Flash') {
						const flashLimit = categoryQuotas.flashQuota ?? Infinity;
						const flashUsage = keyInfoData.categoryUsage?.flash ?? 0;
						if (flashUsage >= flashLimit) {
							console.log(`Skipping key ${keyId}: Flash category quota reached (${flashUsage}/${flashLimit})`);
							quotaExceeded = true;
						}
						// Also check individual model quota if set
						else if (requestedModelId && modelsConfig[requestedModelId]?.individualQuota) {
							const modelLimit = modelsConfig[requestedModelId].individualQuota!;
							const modelUsage = keyInfoData.modelUsage?.[requestedModelId] ?? 0;
							if (modelUsage >= modelLimit) {
								console.log(`Skipping key ${keyId}: Flash model '${requestedModelId}' individual quota reached (${modelUsage}/${modelLimit})`);
								quotaExceeded = true;
							}
						}
					} 
					else if (modelCategory === 'Custom' && requestedModelId) {
						const customLimit = modelsConfig[requestedModelId]?.dailyQuota ?? Infinity;
						const customUsage = keyInfoData.modelUsage?.[requestedModelId] ?? 0;
						if (customUsage >= customLimit) {
							console.log(`Skipping key ${keyId}: Custom model '${requestedModelId}' quota reached (${customUsage}/${customLimit})`);
							quotaExceeded = true;
						}
					}

					if (quotaExceeded) continue;
				}

				// If we get here, the key is valid for use
				selectedKeyId = keyId;
				selectedKeyValue = keyInfoData.key || null;
				break;
			} catch (parseError) {
				console.error(`Failed to parse key info for ID: ${keyId}. Skipping. Error:`, parseError);
				continue;
			}
		}

		// If we couldn't find a valid key after checking all keys
		if (!selectedKeyId || !selectedKeyValue) {
			console.error("No available Gemini keys found after checking all keys.");
			return null;
		}

		// Save the next index for future requests
		ctx.waitUntil(env.GEMINI_KEYS_KV.put(KV_KEY_GEMINI_KEY_INDEX, currentIndex.toString()));
		
		// Save the selected key ID for potential exclusion in case of error handling
		ctx.waitUntil(env.GEMINI_KEYS_KV.put(KV_KEY_LAST_USED_GEMINI_KEY_ID, selectedKeyId));
		
		console.log(`Selected Gemini Key ID via sequential round-robin: ${selectedKeyId} (next index: ${currentIndex})`);

		return {
			id: selectedKeyId,
			key: selectedKeyValue
		};

	} catch (error) {
		console.error("Error retrieving or processing Gemini keys from KV:", error);
		return null;
	}
}

/**
 * Increments the usage count for a given Gemini Key ID in KV.
 * Resets the count if the date has changed.
 * Tracks usage per model and per category (Pro/Flash/Custom).
 * Optionally resets consecutive 429 counters if reset429Counters is true.
 */
async function incrementKeyUsage(keyId: string, env: Env, modelId?: string, category?: 'Pro' | 'Flash' | 'Custom', reset429Counters: boolean = false): Promise<void> {
	const keyKvName = `key:${keyId}`;
	try {
		const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
		if (!keyInfoJson) {
			console.warn(`Cannot increment usage: Key info not found for ID: ${keyId}`);
			return;
		}

		// IMPORTANT: Parse the JSON string from KV
		let keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
		
		// Use consistent helper function for date handling
		const todayInLA = getTodayInLA();

		// Ensure usage fields exist, providing defaults
		let currentTotalUsage = keyInfoData.usage || 0;
		let usageDate = keyInfoData.usageDate || '';
		let modelUsage = keyInfoData.modelUsage || {};
		let categoryUsage = keyInfoData.categoryUsage || { pro: 0, flash: 0 };
		let consecutive429Counts = keyInfoData.consecutive429Counts || {}; // Initialize if missing

		// Reset counters if it's a new day OR if explicitly requested (successful request)
		if (usageDate !== todayInLA) {
			console.log(`Date change detected for key ${keyId} (${usageDate} → ${todayInLA}). Resetting usage and 429 counters.`);
			currentTotalUsage = 0; // Reset total usage
			usageDate = todayInLA;
			modelUsage = {}; // Reset model usage
			categoryUsage = { pro: 0, flash: 0 }; // Reset category usage
			consecutive429Counts = {}; // Reset 429 counts
		} else if (reset429Counters) {
			// If it's the same day but a successful request, reset only the 429 counts
			if (Object.keys(consecutive429Counts).length > 0) {
				console.log(`Successful request or explicit reset for key ${keyId}. Resetting 429 counters.`);
				consecutive429Counts = {};
			}
		}

		// Now, increment the usage for the current request
		currentTotalUsage += 1;

		// Update model-specific usage
		if (modelId) {
			modelUsage[modelId] = (modelUsage[modelId] || 0) + 1;
		}

		// Update category-specific usage based on category
		if (category === 'Pro') {
			categoryUsage.pro = (categoryUsage.pro || 0) + 1;
		} else if (category === 'Flash') {
			categoryUsage.flash = (categoryUsage.flash || 0) + 1;
		}
		// Custom category models are tracked in modelUsage

		// Create the updated object to store, preserving existing fields
		const updatedKeyInfo: Partial<Omit<GeminiKeyInfo, 'id'>> = {
			...keyInfoData,
			usage: currentTotalUsage,
			usageDate: usageDate,
			modelUsage: modelUsage,
			categoryUsage: categoryUsage,
			consecutive429Counts: consecutive429Counts, // Save the (potentially reset) 429 counts
		};
		// Put the updated info back into KV
		await env.GEMINI_KEYS_KV.put(keyKvName, JSON.stringify(updatedKeyInfo));
		console.log(`Usage for key ${keyId} updated. Total: ${updatedKeyInfo.usage}, Date: ${updatedKeyInfo.usageDate}, Model: ${modelId} (${category}), Models: ${JSON.stringify(modelUsage)}, Categories: ${JSON.stringify(categoryUsage)}, 429Counts: ${JSON.stringify(consecutive429Counts)}`);

	} catch (e) {
		console.error(`Failed to increment usage for key ${keyId}:`, e);
		throw e; // Rethrow to allow proper error handling by caller
	}
}


/**
 * Forces the usage count for a specific category/model on a key to its configured daily limit for the current day.
 * This is typically called when a 429 error threshold (e.g., 3 consecutive) is reached.
 * It also resets the specific 429 counter for the model/category that triggered the limit.
 */
async function forceSetQuotaToLimit(keyId: string, env: Env, category: 'Pro' | 'Flash' | 'Custom', modelId?: string, counterKey?: string): Promise<void> {
	const keyKvName = `key:${keyId}`;
	try {
		// Fetch current key info
		const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
		if (!keyInfoJson) {
			console.warn(`Cannot force quota limit: Key info not found for ID: ${keyId}`);
			return;
		}
		let keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;

		// Fetch quota limits
		const [modelsConfigJson, categoryQuotasJson] = await Promise.all([
			env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json"),
			env.WORKER_CONFIG_KV.get(KV_KEY_CATEGORY_QUOTAS, "json")
		]);
		const modelsConfig: Record<string, ModelConfig> = (modelsConfigJson as Record<string, ModelConfig>) || {};
		const categoryQuotas: CategoryQuotas = (categoryQuotasJson as CategoryQuotas) || { proQuota: Infinity, flashQuota: Infinity };

		// Use consistent helper function for date handling
		const todayInLA = getTodayInLA();

		// Ensure usage fields exist
		let usageDate = keyInfoData.usageDate || '';
		let modelUsage = keyInfoData.modelUsage || {};
		let categoryUsage = keyInfoData.categoryUsage || { pro: 0, flash: 0 };
		let consecutive429Counts = keyInfoData.consecutive429Counts || {}; // Initialize if missing

		// If the usageDate is not today, reset everything first, including 429 counts
		if (usageDate !== todayInLA) {
			console.log(`Date change detected in forceSetQuotaToLimit for key ${keyId} (${usageDate} → ${todayInLA}). Resetting usage and 429 counters before forcing limit.`);
			usageDate = todayInLA;
			modelUsage = {}; // Reset model usage
			categoryUsage = { pro: 0, flash: 0 }; // Reset category usage
			consecutive429Counts = {}; // Reset 429 counts
		}

		// Reset the specific 429 counter that triggered this action
		if (counterKey && consecutive429Counts.hasOwnProperty(counterKey)) {
			console.log(`Resetting 429 counter for key ${keyId}, counter ${counterKey} after forcing quota.`);
			delete consecutive429Counts[counterKey]; // Or set to 0, deletion is cleaner
		}

		// Set the specific category/model usage to its limit
		let quotaLimit = Infinity;
		const modelConfig = modelId ? modelsConfig[modelId] : undefined;

		switch (category) {
			case 'Pro':
				// Check if the specific Pro model has an individual quota
				if (modelConfig?.individualQuota) {
					quotaLimit = modelConfig.individualQuota;
					modelUsage[modelId!] = quotaLimit; // modelId must exist here
					console.log(`Forcing Pro model ${modelId} individual usage for key ${keyId} to limit: ${quotaLimit}`);
				} else {
					// No individual quota, force the whole category
					quotaLimit = categoryQuotas.proQuota ?? Infinity;
					categoryUsage.pro = quotaLimit;
					console.log(`Forcing Pro category usage for key ${keyId} to limit: ${quotaLimit}`);
				}
				break;
			case 'Flash':
				// Check if the specific Flash model has an individual quota
				if (modelConfig?.individualQuota) {
					quotaLimit = modelConfig.individualQuota;
					modelUsage[modelId!] = quotaLimit; // modelId must exist here
					console.log(`Forcing Flash model ${modelId} individual usage for key ${keyId} to limit: ${quotaLimit}`);
				} else {
					// No individual quota, force the whole category
					quotaLimit = categoryQuotas.flashQuota ?? Infinity;
					categoryUsage.flash = quotaLimit;
					console.log(`Forcing Flash category usage for key ${keyId} to limit: ${quotaLimit}`);
				}
				break;
			case 'Custom':
				if (modelConfig) {
					quotaLimit = modelConfig.dailyQuota ?? Infinity;
					modelUsage[modelId!] = quotaLimit; // modelId must exist here
					console.log(`Forcing Custom model ${modelId} usage for key ${keyId} to limit: ${quotaLimit}`);
				} else {
					console.warn(`Cannot force quota limit for Custom model: modelId '${modelId}' not provided or not found in config.`);
					return; // Don't proceed if model info is missing
				}
				break;
		}

		// Update the key info object (preserve other fields)
		const updatedKeyInfo: Partial<Omit<GeminiKeyInfo, 'id'>> = {
			...keyInfoData,
			// Do not update total 'usage' here, just the specific category/model
			usageDate: usageDate,
			modelUsage: modelUsage,
			categoryUsage: categoryUsage,
			consecutive429Counts: consecutive429Counts, // Save updated 429 counts
		};

		// Save back to KV
		await env.GEMINI_KEYS_KV.put(keyKvName, JSON.stringify(updatedKeyInfo));
		console.log(`Key ${keyId} quota forced to limit for category ${category}${category === 'Custom' || (modelConfig?.individualQuota && modelId) ? ` (model/counter: ${modelId ?? counterKey})` : ''} for date ${todayInLA}.`);

	} catch (e) {
		console.error(`Failed to force quota limit for key ${keyId}:`, e);
	}
}

/**
 * Handles the logic when a 429 error is received from the Gemini API.
 * Increments the consecutive 429 counter for the specific model/category.
 * If the counter reaches 3 for quota-exceeded errors, triggers forceSetQuotaToLimit.
 */
async function handle429Error(keyId: string, env: Env, category: 'Pro' | 'Flash' | 'Custom', modelId?: string, errorMessage?: string): Promise<void> {
	const keyKvName = `key:${keyId}`;
	const CONSECUTIVE_429_LIMIT = 3;
	const QUOTA_EXCEEDED_MESSAGE = "You exceeded your current quota, please check your plan and billing details.";
	const isQuotaExceeded = errorMessage && errorMessage.includes(QUOTA_EXCEEDED_MESSAGE);

	try {
		// Fetch current key info
		const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
		if (!keyInfoJson) {
			console.warn(`Cannot handle 429: Key info not found for ID: ${keyId}`);
			return;
		}
		let keyInfoData = JSON.parse(keyInfoJson) as Partial<Omit<GeminiKeyInfo, 'id'>>;
		let consecutive429Counts = keyInfoData.consecutive429Counts || {};

		// Determine the specific counter key (model ID or category string)
		let counterKey: string | undefined = undefined;
		let needsQuotaCheck = false; // Does this model/category have a quota defined?

		// Fetch model/category config to decide the counter key and check if quota exists
		const [modelsConfigJson, categoryQuotasJson] = await Promise.all([
			env.WORKER_CONFIG_KV.get(KV_KEY_MODELS, "json"),
			env.WORKER_CONFIG_KV.get(KV_KEY_CATEGORY_QUOTAS, "json")
		]);
		const modelsConfig: Record<string, ModelConfig> = (modelsConfigJson as Record<string, ModelConfig>) || {};
		const categoryQuotas: CategoryQuotas = (categoryQuotasJson as CategoryQuotas) || { proQuota: Infinity, flashQuota: Infinity };
		const modelConfig = modelId ? modelsConfig[modelId] : undefined;

		// 为不同类型的429创建不同的计数器前缀
		const counterPrefix = isQuotaExceeded ? "quota:" : "regular:";

		if (category === 'Custom' && modelId) {
			counterKey = counterPrefix + modelId;
			needsQuotaCheck = isQuotaExceeded && !!modelConfig?.dailyQuota;
		} else if ((category === 'Pro' || category === 'Flash') && modelId && modelConfig?.individualQuota) {
			// Pro/Flash model *with* individual quota -> use model ID as key
			counterKey = counterPrefix + modelId;
			needsQuotaCheck = isQuotaExceeded && true; // Individual quota exists
		} else if (category === 'Pro') {
			// Pro model *without* individual quota -> use category key
			counterKey = counterPrefix + 'category:pro';
			needsQuotaCheck = isQuotaExceeded && !!categoryQuotas?.proQuota && isFinite(categoryQuotas.proQuota);
		} else if (category === 'Flash') {
			// Flash model *without* individual quota -> use category key
			counterKey = counterPrefix + 'category:flash';
			needsQuotaCheck = isQuotaExceeded && !!categoryQuotas?.flashQuota && isFinite(categoryQuotas.flashQuota);
		}

		if (!counterKey) {
			console.warn(`Could not determine counter key for key ${keyId}, category ${category}, model ${modelId}. Skipping 429 handling.`);
			return;
		}
		if (!needsQuotaCheck && isQuotaExceeded) {
			console.log(`Skipping quota-exceeded 429 counter for key ${keyId}, counter ${counterKey} as no relevant quota is configured.`);
			return; // Don't count 429s if there's no quota to hit anyway
		}

		// Increment the counter
		const currentCount = (consecutive429Counts[counterKey] || 0) + 1;
		consecutive429Counts[counterKey] = currentCount;

		if (isQuotaExceeded) {
			console.warn(`Received quota-exceeded 429 for key ${keyId}, counter ${counterKey}. Consecutive count: ${currentCount}`);
		} else {
			console.warn(`Received regular 429 for key ${keyId}, counter ${counterKey}. Consecutive count: ${currentCount}`);
		}

		// The quota limit is enforced only when 429 errors of the quota-exhausted type consecutively reach the threshold
		if (isQuotaExceeded && currentCount >= CONSECUTIVE_429_LIMIT) {
			console.warn(`Consecutive quota-exceeded 429 limit (${CONSECUTIVE_429_LIMIT}) reached for key ${keyId}, counter ${counterKey}. Forcing quota limit.`);
			// Call forceSetQuotaToLimit, passing the counterKey to reset it
			await forceSetQuotaToLimit(keyId, env, category, modelId, counterKey);
			// Note: forceSetQuotaToLimit now handles resetting the specific counter
		} else {
			// Limit not reached or not a quota-exceeded 429, just save the updated counts
			const updatedKeyInfo: Partial<Omit<GeminiKeyInfo, 'id'>> = {
				...keyInfoData,
				consecutive429Counts: consecutive429Counts,
			};
			await env.GEMINI_KEYS_KV.put(keyKvName, JSON.stringify(updatedKeyInfo));
			
			if (!isQuotaExceeded) {
				console.log(`Regular 429 received, only tracking count without forcing quota limit.`);
			}
		}

	} catch (e) {
		console.error(`Failed to handle 429 error for key ${keyId}:`, e);
	}
}


/**
 * Records a 401 or 403 error status for a given Gemini Key ID in KV.
 */
async function recordKeyError(keyId: string, env: Env, status: 401 | 403): Promise<void> {
	const keyKvName = `key:${keyId}`;
	try {
		const keyInfoJson = await env.GEMINI_KEYS_KV.get(keyKvName);
		if (!keyInfoJson) {
			console.warn(`Cannot record error: Key info not found for ID: ${keyId}`);
			return;
		}

		let keyInfoData = JSON.parse(keyInfoJson) as Partial<GeminiKeyInfo>;

		// Update the error status
		keyInfoData.errorStatus = status;

		// Put the updated info back into KV
		await env.GEMINI_KEYS_KV.put(keyKvName, JSON.stringify(keyInfoData));
		console.log(`Recorded error status ${status} for key ${keyId}.`);

	} catch (e) {
		console.error(`Failed to record error status for key ${keyId}:`, e);
		// Don't rethrow here, as recording the error is secondary
	}
}


// Helper to parse JSON body safely
async function readRequestBody<T>(request: Request): Promise<T | null> {
	try {
		return await request.clone().json<T>();
	} catch (e) {
		console.error("Error reading request body:", e);
		return null;
	}
}
