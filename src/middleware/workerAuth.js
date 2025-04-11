const { db } = require('../db'); // Import the database connection

/**
 * Express middleware to validate the Worker API Key provided in the Authorization header.
 * Checks against the `worker_keys` table in the database.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireWorkerAuth(req, res, next) {
    let workerApiKey = null;
    const authHeader = req.headers.authorization;

    // 1. Try Authorization header
    if (authHeader?.startsWith('Bearer ')) {
        workerApiKey = authHeader.substring(7);
    }
    // 2. Try ?key= query parameter if header not found or invalid
    else if (req.query.key && typeof req.query.key === 'string') {
        workerApiKey = req.query.key;
        console.log("Worker key obtained from query parameter."); // Optional logging
    }

    if (!workerApiKey) {
        return res.status(401).json({ error: 'Missing API key. Provide it in the Authorization header as "Bearer YOUR_KEY" or as a "key" query parameter.' });
    }
    // Ensure workerApiKey is trimmed
    workerApiKey = workerApiKey.trim();

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
            req.workerApiKey = workerApiKey;

            // Proceed to the next middleware or route handler
            next();
        });
    } catch (error) {
        console.error('Unexpected error during worker key validation:', error);
        next(error); // Pass to global error handler
    }
}

module.exports = requireWorkerAuth;
