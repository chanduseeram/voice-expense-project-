// Centralized API base URL. Set REACT_APP_API_URL when the backend is deployed
// somewhere other than localhost (see frontend/.env.example).
const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:5000";

export default API_BASE;
