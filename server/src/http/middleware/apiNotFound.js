/** Answers an unknown /api path. Mounted behind requireUser, as the contract says. */
export function apiNotFound(req, res) {
    res.status(404).json({ message: 'Not found' });
}
