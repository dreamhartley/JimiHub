const { db } = require('../db'); // Import the database connection

/**
 * Express middleware to validate the Worker API Key provided in the Authorization header
 * or via a custom property set by a preceding middleware (e.g., from query param).
 * Checks against the `worker_keys` table in the database.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireWorkerAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    let workerApiKey = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;

    // If key not found in header, check the custom property set by workerAuthFromQuery
    if (!workerApiKey && req.workerApiKeyFromQuery) {
        console.log('Using Worker API Key previously found in query parameter.');
        workerApiKey = req.workerApiKeyFromQuery;
    }

    if (!workerApiKey) {
        // If still no key after checking both header and query (via custom property)
        return res.status(401).json({ error: 'Missing API key. Provide it in the Authorization header as "Bearer YOUR_KEY" or as "?key=YOUR_KEY" query parameter.' });
    }

    try {
        // Query the database to see if the key exists
        const sql = `SELECT api_key FROM worker_keys WHERE api_key = ?`;
        db.get(sql, [workerApiKey], (err, row) => {
            if (err) {
                console.error('Database error during worker key validation:', err);
                // Pass error to the global error handler
                return next(err);
            }

            if (!row) {
                // Key not found in the database
                console.warn(`Worker key validation failed: Key "${workerApiKey.slice(0, 5)}..." not found.`);
                return res.status(401).json({ error: 'Invalid API key.' });
            }

            // Key is valid, attach it to the request object for potential use later
            // (e.g., determining safety settings)
            req.workerApiKey = workerApiKey; // Attach the validated key

            // Proceed to the next middleware or route handler
            next();
        });
    } catch (error) {
        console.error('Unexpected error during worker key validation:', error);
        next(error); // Pass to global error handler
    }
}

module.exports = requireWorkerAuth;
