import { useState, useRef, useCallback, useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents, Polyline } from 'react-leaflet';
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './App.css';

// Fix for default marker icon in Leaflet
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

let DefaultIcon = L.icon({
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
    iconSize: [25, 41],
    iconAnchor: [12, 41],
});
L.Marker.prototype.options.icon = DefaultIcon;

/* ── Custom Waypoint Marker ── */
const WaypointIcon = L.divIcon({
    className: 'waypoint-marker-circle',
    html: `<div class="waypoint-inner"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
});

/* ── Map Click Handler ── */
function MapClickHandler({ onMapClick }) {
    useMapEvents({
        click(e) {
            onMapClick(e.latlng);
        }
    });
    return null;
}

/* ── Map auto-track helper ── */
function MapTracker({ position, active }) {
    const map = useMap();
    useEffect(() => {
        if (active && position?.[0] && position?.[1]) {
            map.flyTo(position, 18, { animate: true, duration: 0.8 });
        }
        // Ensuring map tiles render correctly if container resized
        setTimeout(() => map.invalidateSize(), 50);
    }, [position, active, map]);
    return null;
}

/* ── Static ROS2 set_route payload ── */
const STATIC_ROUTE = {
    type: 'set_route',
    data: {
        route: [
            { header: { frame_id: 'map' }, pose: { position: { x: 0.0, y: 0.0, z: 0.0 } } },
        ],
    },
};

/* ── Helpers ── */
function wsUrl() {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const hostname = window.location.hostname;
    return `${proto}://${hostname}:3000`;
}

const formatPST = () =>
    new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour12: false,
    }) + ' PST';

/* ══════════════════════════════════════════════════════════════════
   App Component
   ══════════════════════════════════════════════════════════════════ */
export default function App() {
    // ── Auth & connectivity state ──
    const [screen, setScreen] = useState('login');
    const [username, setUsername] = useState('admin');
    const [waypoints, setWaypoints] = useState([]);
    const [password, setPassword] = useState('123456');
    const [status, setStatus] = useState('Disconnected');

    // ── Telemetry & operational state ──
    const [logs, setLogs] = useState([]);
    const [telemetry, setTelemetry] = useState(null);
    const [autoTrack, setAutoTrack] = useState(true);
    const [clock, setClock] = useState(formatPST());
    const [activeTab, setActiveTab] = useState(1);
    const [actionOnArrival, setActionOnArrival] = useState(false);
    const [targetLat, setTargetLat] = useState("");
    const [targetLng, setTargetLng] = useState("");
    const [pathHistory, setPathHistory] = useState([]);
    const [sessionLocked, setSessionLocked] = useState(false);
    const [telemetryHistory, setTelemetryHistory] = useState([]);
    const [speedRequest, setSpeedRequest] = useState(2.4);
    const [autoLogScroll, setAutoLogScroll] = useState(true);

    // ── Camera toggle ──
    const [cameraOpen, setCameraOpen] = useState(false);

    const wsRef = useRef(null);
    const logScrollRef = useRef(null);
    const dPadInterval = useRef(null);
    const activeKeyRef = useRef(null);

    /* Clock ticker */
    useEffect(() => {
        const timer = setInterval(() => setClock(formatPST()), 1000);
        return () => clearInterval(timer);
    }, []);

    /* Auto-scroll log console */
    useEffect(() => {
        if (autoLogScroll && logScrollRef.current) {
            const scroll = () => {
                if (logScrollRef.current) {
                    logScrollRef.current.scrollTo({
                        top: logScrollRef.current.scrollHeight,
                        behavior: 'smooth'
                    });
                }
            };
            scroll();
            setTimeout(scroll, 100);
        }
    }, [logs, autoLogScroll]);

    /* Append a log entry (max 50 entries) */
    const addLog = useCallback((tag, msg, isAlert = false) => {
        setLogs(prev =>
            [...prev, { time: new Date().toLocaleTimeString('en-GB'), tag, msg, alert: isAlert }]
                .slice(-50),
        );
    }, []);

    /* Send a message over the WebSocket */
    const send = useCallback((obj) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(obj));
        }
    }, []);

    /* Continuous D-Pad drive handlers */
    const startDrive = useCallback((dir) => {
        if (!sessionLocked) return;
        if (dPadInterval.current) clearInterval(dPadInterval.current);
        send({ type: 'manual_cmd', data: { direction: dir } });
        dPadInterval.current = setInterval(() => {
            send({ type: 'manual_cmd', data: { direction: dir } });
        }, 100);
    }, [sessionLocked, send]);

    const stopDrive = useCallback(() => {
        if (dPadInterval.current) {
            clearInterval(dPadInterval.current);
            dPadInterval.current = null;
        }
        send({ type: 'manual_cmd', data: { direction: 'stop' } });
    }, [send]);

    /* Keyboard mapping for Manual Control */
    useEffect(() => {
        // Only allow keyboard controls when in the dashboard and on the Manual Control tab
        if (screen !== 'dashboard' || activeTab !== 1) return;

        const handleKeyDown = (e) => {
            // Prevent continuous firing when a key is held down
            if (e.repeat) return;

            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                // Ensure manual mode is engaged
                if (!sessionLocked) setSessionLocked(true);
                
                let dir;
                if (e.key === 'ArrowUp') dir = 'forward';
                if (e.key === 'ArrowDown') dir = 'backward';
                if (e.key === 'ArrowLeft') dir = 'left';
                if (e.key === 'ArrowRight') dir = 'right';
                
                if (dir) {
                    send({ type: 'manual_cmd', data: { direction: dir } });
                    activeKeyRef.current = e.key;
                }
            }
        };

        const handleKeyUp = (e) => {
            if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
                e.preventDefault();
                // Only send stop if the released key is the currently active one
                if (activeKeyRef.current === e.key) {
                    send({ type: 'manual_cmd', data: { direction: 'stop' } });
                    activeKeyRef.current = null;
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown, { passive: false });
        window.addEventListener('keyup', handleKeyUp, { passive: false });
        
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
        };
    }, [screen, activeTab, sessionLocked, send]);

    /* ── Login / WebSocket init ── */
    const handleLogin = (e) => {
        e.preventDefault();
        setStatus('Connecting…');
        const ws = new WebSocket(wsUrl());
        wsRef.current = ws;

        ws.onopen = () => {
            setStatus('Authenticating…');
            ws.send(JSON.stringify({ type: 'auth', data: { username, password } }));
        };

        ws.onmessage = (evt) => {
            let msg;
            try { msg = JSON.parse(evt.data); } catch { return; }

            switch (msg.type) {
                case 'auth_ok':
                    setStatus('OPERATIONAL');
                    setScreen('dashboard');
                    addLog('SYSTEM', 'Authentication successful');
                    break;
                case 'auth_fail':
                    setStatus('Auth failed');
                    addLog('AUTH', `Failed: ${msg.message}`, true);
                    ws.close();
                    break;
                case 'telemetry':
                    setTelemetry(msg.data);
                    if (msg.data.gps?.lat && msg.data.gps?.lng) {
                        const currentPos = [msg.data.gps.lat, msg.data.gps.lng];
                        setPathHistory(prev => {
                            const lastPoint = prev[prev.length - 1];
                            if (!lastPoint || Math.abs(lastPoint[0] - currentPos[0]) > 0.000005 || Math.abs(lastPoint[1] - currentPos[1]) > 0.000005) {
                                return [...prev, currentPos];
                            }
                            return prev;
                        });
                        setTelemetryHistory(prev => [...prev, {
                            time: new Date().toISOString(),
                            lat: msg.data.gps.lat,
                            lng: msg.data.gps.lng,
                            speed: msg.data.speed || 0,
                            battery: msg.data.batteryPercent || 0
                        }]);
                    }
                    if (Math.random() > 0.95 && msg.data.speed > 0) {
                        addLog('GPS', `Position: ${msg.data.gps.lat.toFixed(4)}°N`);
                    }
                    if (msg.data.batteryPercent < 20 && Math.random() > 0.98) {
                        addLog('ALERT', '⚠ Battery critically low', true);
                    }
                    break;
                case 'cmd_ack':
                case 'waypoint_ack':
                    addLog('CMD', msg.message);
                    break;
                case 'error':
                    addLog('ERROR', msg.message, true);
                    break;
                default:
                    break;
            }
        };

        ws.onclose = () => setStatus('OFFLINE');
        ws.onerror = () => setStatus('OFFLINE');
    };

    const handleEStop = () => {
        send({ type: 'emergency_stop' });
        setSessionLocked(false);
        setPathHistory([]);
        setWaypoints([]);
        addLog('SYSTEM', 'SOFTWARE E-STOP ENGAGED - ALL OPERATIONS HALTED', true);
    };

    const handleStop = () => {
        send({ type: 'manual_cmd', data: { direction: 'stop' } });
        setSessionLocked(false);
        setPathHistory([]);
        setWaypoints([]);
        setTargetLat('');
        setTargetLng('');
        setActionOnArrival(false);
        addLog('SYSTEM', 'Stop command sent. Session unlocked and state reset.');
    };

    const exportCSV = () => {
        if (telemetryHistory.length === 0 && logs.length === 0) {
            addLog('SYSTEM', 'No session data to export');
            return;
        }

        let csvContent = "Type,Timestamp,Field1,Field2,Field3,Field4\n";

        // Add telemetry rows
        telemetryHistory.forEach(row => {
            csvContent += `TELEMETRY,${row.time},${row.lat},${row.lng},${row.speed},${row.battery}\n`;
        });

        // Add a separator
        csvContent += "\nType,Timestamp,Tag,Message,,\n";

        // Add log rows
        logs.forEach(log => {
            csvContent += `LOG,${log.time},${log.tag},"${log.msg}",,\n`;
        });

        const blob = new Blob([csvContent], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `ugv-mission-summary-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
        a.click();
        addLog('SYSTEM', 'Mission summary exported to CSV');
    };

    const calculateDynamicRoute = async () => {
        if (!targetLat || !targetLng || !telemetry?.gps) {
            addLog('ERROR', 'Need target Lat/Lng and current GPS', true);
            return;
        }
        addLog('SYSTEM', 'Calculating dynamic route via OSRM...');
        try {
            const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${telemetry.gps.lng},${telemetry.gps.lat};${targetLng},${targetLat}?overview=full&geometries=geojson`);
            const data = await res.json();
            if (data.routes && data.routes[0]) {
                const coords = data.routes[0].geometry.coordinates;
                const wps = coords.map(c => ({ lat: c[1], lng: c[0] }));
                setWaypoints(wps);
                addLog('SYSTEM', `Dynamic route calculated. ${wps.length} waypoints.`);
            }
        } catch (e) {
            addLog('ERROR', 'Routing failed', true);
        }
    };

    const engageManual = () => {
        send({ type: 'manual_cmd', data: { engage: true } });
        setSessionLocked(true);
        addLog('SYSTEM', 'Manual mode locked & engaged');
    }

    const handleDisconnect = () => {
        wsRef.current?.close();
        setScreen('login');
        setTelemetry(null);
        setStatus('Disconnected');
        setLogs([]);
    };

    /* ── Waypoint / Mission Logic ── */
    const handleMapClick = useCallback((latlng) => {
        if (activeTab === 3 && !sessionLocked) {
            setTargetLat(latlng.lat.toFixed(6));
            setTargetLng(latlng.lng.toFixed(6));
            addLog('MAP', `Target set to: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`);
        } else if (activeTab === 2 && !sessionLocked) {
            setWaypoints(prev => [...prev, latlng]);
        }
    }, [activeTab, sessionLocked, addLog]);

    const handleClearRoute = () => {
        setWaypoints([]);
        addLog('SYSTEM', 'Mission waypoints cleared');
    };

    const handleSendMission = () => {
        if (waypoints.length === 0) {
            addLog('ERROR', 'No waypoints to send', true);
            return;
        }
        setSessionLocked(true);
        const payload = {
            type: 'set_route',
            data: {
                explodeOnArrival: activeTab !== 1 ? actionOnArrival : false,
                route: waypoints.map(wp => ({
                    header: { frame_id: 'map' },
                    pose: {
                        position: { x: wp.lat, y: wp.lng, z: 0.0 },
                        orientation: { x: 0.0, y: 0.0, z: 0.0, w: 1.0 }
                    }
                }))
            }
        };
        send(payload);
        setSessionLocked(true);
        addLog('CMD', `Mission sent: ${waypoints.length} waypoints. Session LOCKED.`);
    };

    /* ── Derived telemetry ── */
    const batt = Math.round(telemetry?.batteryPercent ?? 0);
    const battLow = batt > 0 && batt < 20;
    const battColor = battLow ? 'var(--accent-red)' : 'var(--accent-primary)';
    const leftSpeed = (telemetry?.leftSpeed ?? 0).toFixed(1);
    const rightSpeed = (telemetry?.rightSpeed ?? 0).toFixed(1);
    const heading = Math.round(telemetry?.heading ?? 0);
    const lat = (telemetry?.gps?.lat ?? 0).toFixed(5);
    const lng = (telemetry?.gps?.lng ?? 0).toFixed(5);
    const temp = telemetry?.componentsTemp ? Math.round(telemetry.componentsTemp) : '--';
    const tempHigh = typeof temp === 'number' && temp > 70;

    // Motor and RPi currents
    const leftCurr = (telemetry?.leftMotorCurrent ?? 0).toFixed(2);
    const rightCurr = (telemetry?.rightMotorCurrent ?? 0).toFixed(2);
    const rpiCurr = (telemetry?.rpiCurrent ?? 0).toFixed(2);

    // Tone and Errors
    const toneActive = telemetry?.tone === 1;
    const errorMessage = telemetry?.msgError ?? "";

    const isOnline = status === 'OPERATIONAL';
    const ugvPos = telemetry?.gps
        ? [telemetry.gps.lat, telemetry.gps.lng]
        : [34.0522, -118.2437]; // Default: LA

    /* ════════════════════════════════════════════════════════════════
       LOGIN SCREEN
       ════════════════════════════════════════════════════════════════ */
    if (screen === 'login') {
        return (
            <div className="login-overlay" role="main">
                <div className="login-card" aria-label="UGV Command Center Login">
                    <span className="login-logo" aria-hidden="true">⬡</span>
                    <h1>UGV COMMAND CENTER</h1>
                    <p className="login-subtitle">SECURE REMOTE OPERATIONS v1.2</p>
                    <form onSubmit={handleLogin} noValidate>
                        <label htmlFor="ugv-username" style={{ display: 'none' }}>Access Code</label>
                        <input
                            id="ugv-username"
                            type="text"
                            placeholder="Access Code"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            autoComplete="username"
                            required
                        />
                        <label htmlFor="ugv-password" style={{ display: 'none' }}>Passphrase</label>
                        <input
                            id="ugv-password"
                            type="password"
                            placeholder="Passphrase"
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            autoComplete="current-password"
                            required
                        />
                        <button type="submit" className="btn-primary" id="login-submit-btn">
                            INITIALIZE CONNECTION
                        </button>
                    </form>
                    <span className="status-badge" aria-live="polite">{status}</span>
                </div>
            </div>
        );
    }

    /* ════════════════════════════════════════════════════════════════
       DASHBOARD SCREEN
       ════════════════════════════════════════════════════════════════ */
    return (
        <div className="app">

            {/* ── Header ── */}
            <header className="top-header" role="banner">
                <div className="header-left">
                    <span className="header-menu-icon" aria-hidden="true">≡</span>
                    <span className="header-title">UGV COMMAND CENTER</span>
                    <span className="header-version">v1.2</span>
                </div>

                <div className="header-center" aria-label="Current time">{clock}</div>

                <div className="header-right">
                    <div className="header-status" aria-live="polite">
                        {isOnline && (
                            <div className="tone-indicator-wrap">
                                <div className={`tone-lamp ${toneActive ? 'active' : ''}`} title="System Tone Indicator" />
                                <span className="tone-label">{toneActive ? 'ALARM' : 'OK'}</span>
                            </div>
                        )}
                        <button onClick={handleEStop} className="btn-estop">SOFTWARE E-STOP</button>
                        <button onClick={exportCSV} className="btn-export">EXPORT CSV</button>
                        <span style={{ marginLeft: '10px' }}>STATUS:</span>
                        <span
                            className="status-label"
                            style={{ color: isOnline ? 'var(--accent-primary)' : 'var(--fg-secondary)' }}
                        >
                            {status}
                        </span>
                    </div>

                    <div className="header-user" aria-label="Logged in user">
                        <div className="user-avatar" aria-hidden="true">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" strokeWidth="2" aria-hidden="true">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                                <circle cx="12" cy="7" r="4" />
                            </svg>
                        </div>
                        <div>
                            <div style={{ color: 'var(--fg-primary)', fontWeight: 600 }}>Admin</div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-secondary)' }}>hamoly</div>
                        </div>
                    </div>

                    <button
                        className="header-disconnect-btn"
                        onClick={handleDisconnect}
                        id="disconnect-btn"
                        aria-label="Disconnect from vehicle"
                    >
                        DISCONNECT
                    </button>
                </div>
            </header>

            {/* ── Dashboard Grid ── */}
            <main className="dashboard-grid" role="main">
                <PanelGroup orientation="horizontal">
                    {/* ═══ LEFT SIDEBAR — Operations ═══ */}
                    <Panel defaultSize={20} minSize={15}>
                        <div className="panel sidebar-left panel-content-area" aria-label="Operations Panel">


                            <div className="panel-title">
                                <span className="panel-icon" aria-hidden="true">⬡</span>
                                Operations
                            </div>

                            <div className="tabs-container">
                                <button
                                    className={`tab-btn ${activeTab === 1 ? 'active' : ''}`}
                                    onClick={() => setActiveTab(1)}
                                    disabled={sessionLocked}
                                    title={sessionLocked ? "Unlock session to switch modes" : "Manual Control"}
                                >
                                    MANUAL
                                </button>
                                <button
                                    className={`tab-btn ${activeTab === 2 ? 'active' : ''}`}
                                    onClick={() => setActiveTab(2)}
                                    disabled={sessionLocked}
                                    title={sessionLocked ? "Unlock session to switch modes" : "Predefined Auto"}
                                >
                                    AUTO (PRE)
                                </button>
                                <button
                                    className={`tab-btn ${activeTab === 3 ? 'active' : ''}`}
                                    onClick={() => setActiveTab(3)}
                                    disabled={sessionLocked}
                                    title={sessionLocked ? "Unlock session to switch modes" : "Dynamic Auto"}
                                >
                                    AUTO (DYN)
                                </button>
                            </div>
                            {sessionLocked && <div className="session-lock-indicator">⚠ MISSION IN PROGRESS — SESSION LOCKED</div>}

                            {/* MODE 1: MANUAL */}
                            {activeTab === 1 && (
                                <div className="mode-content">
                                    <div className="section-label">Direct Drive Control</div>
                                    <div className="control-buttons-stack" style={{ marginBottom: '16px' }}>
                                        <button
                                            className={`btn-action engage ${sessionLocked ? 'active' : ''}`}
                                            onClick={engageManual}
                                            disabled={sessionLocked}
                                        >
                                            {sessionLocked ? '● MANUAL ENGAGED' : '▶ ENGAGE MANUAL'}
                                        </button>
                                    </div>
                                    <div className="dpad-section">
                                        <div className="dpad-container">
                                            <div className="dpad-cross">
                                                <button className="dbtn n" onMouseDown={() => startDrive('forward')} onMouseUp={stopDrive} onMouseLeave={stopDrive} onTouchStart={(e) => { e.preventDefault(); startDrive('forward'); }} onTouchEnd={(e) => { e.preventDefault(); stopDrive(); }}>▲</button>
                                                <button className="dbtn w" onMouseDown={() => startDrive('left')} onMouseUp={stopDrive} onMouseLeave={stopDrive} onTouchStart={(e) => { e.preventDefault(); startDrive('left'); }} onTouchEnd={(e) => { e.preventDefault(); stopDrive(); }}>◀</button>
                                                <button className="dbtn e" onMouseDown={() => startDrive('right')} onMouseUp={stopDrive} onMouseLeave={stopDrive} onTouchStart={(e) => { e.preventDefault(); startDrive('right'); }} onTouchEnd={(e) => { e.preventDefault(); stopDrive(); }}>▶</button>
                                                <button className="dbtn s" onMouseDown={() => startDrive('backward')} onMouseUp={stopDrive} onMouseLeave={stopDrive} onTouchStart={(e) => { e.preventDefault(); startDrive('backward'); }} onTouchEnd={(e) => { e.preventDefault(); stopDrive(); }}>▼</button>
                                            </div>
                                            <button className="btn-stop" onClick={handleStop}>⬛ STOP & RESET</button>
                                        </div>
                                    </div>
                                    <div style={{ marginTop: '20px' }}>
                                        <button
                                            className="btn-action prominent"
                                            style={{ width: '100%' }}
                                            onClick={() => {
                                                send({ type: 'payload_action', data: { action: 'explode' } });
                                                addLog('PAYLOAD', 'ACTION / EXPLODE COMMAND SENT', true);
                                            }}
                                        >
                                            💣 ACTION / EXPLODE
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* MODE 2: AUTO PREDEFINED */}
                            {activeTab === 2 && (
                                <div className="mode-content">
                                    <div className="section-label">Predefined Waypoints</div>
                                    <select
                                        className="waypoint-select"
                                        onChange={(e) => {
                                            if (e.target.value === 'wp1') setWaypoints([{ lat: 34.0522, lng: -118.2437 }, { lat: 34.0530, lng: -118.2440 }]);
                                            if (e.target.value === 'wp2') setWaypoints([{ lat: 34.0522, lng: -118.2437 }, { lat: 34.0515, lng: -118.2450 }, { lat: 34.0510, lng: -118.2430 }]);
                                            if (e.target.value === 'clear') setWaypoints([]);
                                        }}
                                        style={{ width: '100%', padding: '10px', marginBottom: '16px', background: 'var(--bg-elevated)', color: 'var(--fg-primary)', border: '1px solid var(--border-default)', borderRadius: '4px' }}
                                        disabled={sessionLocked}
                                    >
                                        <option value="clear">Select Mission Profile...</option>
                                        <option value="wp1">Alpha Patrol Route</option>
                                        <option value="wp2">Bravo Perimeter Survey</option>
                                    </select>

                                    <label className="payload-checkbox">
                                        <input type="checkbox" checked={actionOnArrival} onChange={(e) => !sessionLocked && setActionOnArrival(e.target.checked)} disabled={sessionLocked} />
                                        <span>Action/Explode on Arrival</span>
                                    </label>

                                    <div className="control-buttons-stack">
                                        <button className="btn-action mission-send" onClick={handleSendMission} disabled={sessionLocked || waypoints.length === 0}>
                                            INITIATE AUTONOMOUS MISSION
                                        </button>
                                        <button className="btn-stop" onClick={handleStop}>⬛ STOP & RESET</button>
                                    </div>
                                </div>
                            )}

                            {/* MODE 3: AUTO DYNAMIC */}
                            {activeTab === 3 && (
                                <div className="mode-content">
                                    <div className="section-label">Dynamic Routing Target</div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '16px' }}>
                                        <div className="input-group">
                                            <span className="input-label">LAT</span>
                                            <input type="number" placeholder="0.000000" value={targetLat} onChange={e => setTargetLat(e.target.value)} disabled={sessionLocked} />
                                        </div>
                                        <div className="input-group">
                                            <span className="input-label">LNG</span>
                                            <input type="number" placeholder="0.000000" value={targetLng} onChange={e => setTargetLng(e.target.value)} disabled={sessionLocked} />
                                        </div>
                                    </div>
                                    <button className="btn-action" onClick={calculateDynamicRoute} disabled={sessionLocked || !targetLat || !targetLng} style={{ width: '100%', marginBottom: '16px' }}>
                                        CALCULATE OPTIMAL ROUTE
                                    </button>

                                    <label className="payload-checkbox">
                                        <input type="checkbox" checked={actionOnArrival} onChange={(e) => !sessionLocked && setActionOnArrival(e.target.checked)} disabled={sessionLocked} />
                                        <span>Action/Explode on Arrival</span>
                                    </label>

                                    <div className="control-buttons-stack">
                                        <button className="btn-action mission-send" onClick={handleSendMission} disabled={sessionLocked || waypoints.length === 0}>
                                            INITIATE DYNAMIC MISSION
                                        </button>
                                        <button className="btn-stop" onClick={handleStop}>⬛ STOP & RESET</button>
                                        <button className="btn-action clear-draw" onClick={() => { setWaypoints([]); setPathHistory([]); }} disabled={sessionLocked}>
                                            CLEAR PLOTTED DATA
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Speed slider (Shown in all modes) */}
                            <div className="section-label" style={{ marginTop: 'var(--sp-4)' }}>Max Speed Limit</div>
                            <div className="speed-slider">
                                <div className="slider-labels">
                                    <span>0 m/s</span>
                                    <span className="slider-val">{speedRequest.toFixed(1)} m/s</span>
                                    <span>5.0 m/s</span>
                                </div>
                                <div className="slider-rail">
                                    <div className="slider-fill" style={{ width: `${(speedRequest / 5) * 100}%` }} />
                                    <div className="slider-thumb" style={{ left: `${(speedRequest / 5) * 100}%` }} />
                                    <input
                                        type="range"
                                        min="0" max="5" step="0.1"
                                        className="slider-input-overlay"
                                        value={speedRequest}
                                        id="speed-slider"
                                        aria-label="Speed request"
                                        onChange={e => setSpeedRequest(parseFloat(e.target.value))}
                                    />
                                </div>
                            </div>
                        </div>
                    </Panel>

                    <PanelResizeHandle className="resize-handle horizontal" />

                    {/* ═══ CENTER — Map & Logs ═══ */}
                    <Panel defaultSize={60} minSize={30}>
                        <PanelGroup orientation="vertical">
                            {/* Map Area */}
                            <Panel defaultSize={75} minSize={40}>
                                <div className="map-wrap" style={{ height: '100%', width: '100%', position: 'relative' }}>
                                    {/* Map tools bar */}
                                    <div className="map-tools">
                                        <button
                                            className={`map-tool-btn ${autoTrack ? 'active' : ''}`}
                                            id="auto-track-btn"
                                            onClick={() => setAutoTrack(!autoTrack)}
                                            aria-pressed={autoTrack}
                                            aria-label={autoTrack ? 'Disable auto-focus' : 'Enable auto-focus'}
                                        >
                                            {autoTrack ? '⊙ Auto-Focus ON' : '○ Auto-Focus OFF'}
                                        </button>
                                    </div>

                                    {/* Leaflet map */}
                                    <MapContainer
                                        center={ugvPos}
                                        zoom={16}
                                        zoomControl={false}
                                        className="leaflet-container"
                                        aria-label="UGV location map"
                                    >
                                        <TileLayer
                                            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                                            attribution="Esri World Imagery"
                                        />
                                        <MapClickHandler onMapClick={handleMapClick} />

                                        {/* Intended Mission Path (Road Snapped) */}
                                        {waypoints.length > 0 && (
                                            <Polyline
                                                positions={[ugvPos, ...waypoints.map(wp => [wp.lat, wp.lng])]}
                                                pathOptions={{ color: 'rgba(0, 255, 65, 0.6)', weight: 4, dashArray: '10, 10' }}
                                            />
                                        )}

                                        {waypoints.map((wp, i) => (
                                            <Marker key={i} position={wp} icon={WaypointIcon}>
                                                <Popup>
                                                    <strong>Waypoint {i + 1}</strong><br />
                                                    Lat: {wp.lat.toFixed(6)}<br />
                                                    Lng: {wp.lng.toFixed(6)}
                                                </Popup>
                                            </Marker>
                                        ))}

                                        {/* Historical Path Trail (Uber-style) */}
                                        {pathHistory.length > 1 && (
                                            <>
                                                <Polyline
                                                    positions={pathHistory}
                                                    pathOptions={{ color: "#38BDF8", weight: 6, opacity: 0.3 }}
                                                />
                                                <Polyline
                                                    positions={pathHistory}
                                                    pathOptions={{ color: "#38BDF8", weight: 3, opacity: 1 }}
                                                />
                                            </>
                                        )}

                                        <Marker
                                            position={ugvPos}
                                            icon={L.divIcon({
                                                className: 'ugv-tank-marker',
                                                html: `<div style="filter: drop-shadow(0 0 10px rgba(0,255,65,0.4));">
                                          <img src="/tank.png" style="width: 52px; height: 52px; transform: rotate(${heading}deg); transition: transform 0.5s ease-out;" />
                                       </div>`,
                                                iconSize: [52, 52],
                                                iconAnchor: [26, 26],
                                                popupAnchor: [0, -20]
                                            })}
                                        >
                                            <Popup>
                                                <div className="popup-hud">
                                                    <div className="popup-title">UGV-01 NOMAD</div>
                                                    <div className="popup-data">LAT: {telemetry?.gps?.lat?.toFixed(6) ?? '0.000000'}</div>
                                                    <div className="popup-data">LNG: {telemetry?.gps?.lng?.toFixed(6) ?? '0.000000'}</div>
                                                    <div className="popup-data">STATUS: {isOnline ? 'OPERATIONAL' : 'OFFLINE'}</div>
                                                </div>
                                            </Popup>
                                        </Marker>
                                        <MapTracker position={ugvPos} active={autoTrack} />
                                    </MapContainer>
                                </div>
                            </Panel>

                            <PanelResizeHandle className="resize-handle vertical" />

                            <Panel defaultSize={25} minSize={15}>
                                <div className="log-area" style={{ height: '100%', marginBottom: 0, padding: '10px', background: 'var(--bg-base)', borderTop: '1px solid var(--border-default)' }}>
                                    <div className="log-console-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <div className="log-console-dot" aria-hidden="true" />
                                            EVENT LOG
                                        </div>
                                        <label style={{ fontSize: '10px', color: 'var(--fg-secondary)', display: 'flex', gap: '4px', cursor: 'pointer', background: 'var(--bg-elevated)', padding: '2px 6px', borderRadius: '4px', border: '1px solid var(--border-default)' }}>
                                            <input type="checkbox" checked={autoLogScroll} onChange={(e) => setAutoLogScroll(e.target.checked)} />
                                            AUTO SCROLL
                                        </label>
                                    </div>
                                    <div className="log-scroll" ref={logScrollRef}>
                                        {logs.length === 0 && (
                                            <div className="log-line">
                                                <span className="log-time">[{clock.split(' ')[0]}]</span>
                                                <span className="log-tag">SYSTEM:</span>
                                                <span className="log-msg">Waiting for events…</span>
                                            </div>
                                        )}
                                        {logs.map((l, i) => (
                                            <div key={i} className="log-line">
                                                <span className="log-time">[{l.time}]</span>
                                                <span className={`log-tag ${l.alert ? 'alert' : ''}`}>{l.tag}:</span>
                                                <span className="log-msg">{l.msg}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </Panel>
                        </PanelGroup>
                    </Panel>

                    <PanelResizeHandle className="resize-handle horizontal" />

                    {/* ═══ RIGHT sidebar — Telemetry ═══ */}
                    <Panel defaultSize={20} minSize={15}>
                        <div className="panel right-sidebar panel-content-area" aria-label="Telemetry widgets">

                            {/* Battery Ring */}
                            <div className={`widget ${battLow ? 'alert-border' : ''}`} aria-label={`Battery: ${batt}%`}>
                                <div className="widget-title">
                                    <span className="widget-title-icon" aria-hidden="true">⚡</span>
                                    Battery
                                    {battLow && (
                                        <span className="alert-badge critical" role="alert" aria-label="Critical battery level">
                                            ⚠ LOW
                                        </span>
                                    )}
                                </div>
                                <div className="battery-wrap">
                                    <svg viewBox="0 0 36 36" className="circular-chart" aria-hidden="true">
                                        <path
                                            className="circle-bg"
                                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                        />
                                        <path
                                            className="circle"
                                            strokeDasharray={`${batt}, 100`}
                                            stroke={battColor}
                                            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                        />
                                        <text x="18" y="20.35" className="percentage">{batt}%</text>
                                    </svg>
                                    <div className="battery-meta">
                                        <span className="battery-label">Charge Level</span>
                                        <span className={`battery-status ${battLow ? 'low' : 'ok'}`}>
                                            {battLow ? '⚠ CRITICAL' : '● NOMINAL'}
                                        </span>
                                    </div>
                                </div>
                            </div>

                            {/* Dual Speed Bar */}
                            <div className="widget" aria-label={`Left Speed: ${leftSpeed}, Right Speed: ${rightSpeed} m/s`}>
                                <div className="widget-title">
                                    <span className="widget-title-icon" aria-hidden="true">📊</span>
                                    Speed (L / R)
                                </div>
                                <div className="dual-speed-container">
                                    <div className="speed-column">
                                        <div className="speed-ticks vertical" aria-hidden="true">
                                            {[...Array(12)].map((_, i) => (
                                                <div key={i} className={`tick vertical ${(i / 12) * 5 <= leftSpeed ? 'active' : ''}`} />
                                            ))}
                                        </div>
                                        <div className="speed-label-mini">LEFT</div>
                                        <div className="speed-val-mini">{leftSpeed}</div>
                                    </div>
                                    <div className="speed-column">
                                        <div className="speed-ticks vertical" aria-hidden="true">
                                            {[...Array(12)].map((_, i) => (
                                                <div key={i} className={`tick vertical ${(i / 12) * 5 <= rightSpeed ? 'active' : ''}`} />
                                            ))}
                                        </div>
                                        <div className="speed-label-mini">RIGHT</div>
                                        <div className="speed-val-mini">{rightSpeed}</div>
                                    </div>
                                </div>
                            </div>

                            {/* Power & Current Telemetry */}
                            <div className="widget" aria-label="Power and Current Monitoring">
                                <div className="widget-title">
                                    <span className="widget-title-icon" aria-hidden="true">⚡</span>
                                    Power Diagnostics
                                </div>
                                <div className="power-diagnostics-grid">
                                    <div className="power-item">
                                        <div className="power-label">MOTOR L</div>
                                        <div className="power-val">{leftCurr}<span>A</span></div>
                                    </div>
                                    <div className="power-item">
                                        <div className="power-label">MOTOR R</div>
                                        <div className="power-val">{rightCurr}<span>A</span></div>
                                    </div>
                                    <div className="power-item wide">
                                        <div className="power-label">SYSTEM (RPI)</div>
                                        <div className="power-val">{rpiCurr}<span>A</span></div>
                                    </div>
                                </div>
                            </div>

                            {/* Error Message Dashboard */}
                            {errorMessage && (
                                <div className="widget error-terminal-widget" role="alert">
                                    <div className="widget-title" style={{ color: 'var(--accent-red)' }}>
                                        <span className="widget-title-icon">⚠</span>
                                        SYSTEM ERROR
                                    </div>
                                    <div className="error-msg-box">
                                        {errorMessage}
                                    </div>
                                </div>
                            )}

                            {/* Compass */}
                            <div className="widget" aria-label={`Heading: ${heading} degrees`}>
                                <div className="widget-title">
                                    <span className="widget-title-icon" aria-hidden="true">🧭</span>
                                    Compass
                                </div>
                                <div className="compass-wrap">
                                    <div className="compass-circle">
                                        <div
                                            className="compass-arrow"
                                            style={{ transform: `rotate(${heading}deg)` }}
                                            aria-hidden="true"
                                        >▼</div>
                                        <div className="compass-val">{heading}°</div>
                                    </div>
                                </div>
                            </div>

                            {/* GPS Coordinates */}
                            <div className="widget" aria-label={`GPS: ${lat}°N, ${lng}°W`}>
                                <div className="widget-title">
                                    <span className="widget-title-icon" aria-hidden="true">📡</span>
                                    GPS Position
                                </div>
                                <div className="gps-text">
                                    <div>{lat}° N</div>
                                    <div>{lng}° W</div>
                                </div>
                            </div>

                            {/* Status & Temperature */}
                            <div
                                className="status-grid"
                                role="region"
                                aria-label="System status indicators"
                            >
                                {/* Connection status */}
                                <div className={`status-box ${!isOnline ? 'alert-border' : ''}`}>
                                    <div className="status-box-title">STATUS</div>
                                    <div
                                        className="status-box-val"
                                        style={{ color: isOnline ? 'var(--accent-primary)' : 'var(--fg-secondary)' }}
                                    >
                                        <div className={`status-indicator ${isOnline ? 'online' : ''}`} aria-hidden="true" />
                                        {isOnline ? 'ONLINE' : 'OFFLINE'}
                                    </div>
                                </div>

                                {/* Temperature */}
                                <div className={`status-box ${tempHigh ? 'warn-border' : ''}`}>
                                    <div className="status-box-title">TEMP</div>
                                    <div
                                        className="status-box-val"
                                        style={{ color: tempHigh ? 'var(--accent-amber)' : 'var(--fg-primary)' }}
                                    >
                                        {tempHigh && <span aria-label="High temperature warning">⚠ </span>}
                                        {temp}°C
                                    </div>
                                </div>
                            </div>

                            {/* ── Camera — Toggleable Feed ── */}
                            <div
                                className={`camera-widget ${cameraOpen ? 'camera-expanded' : ''}`}
                                aria-label="Camera view panel"
                            >
                                <div className="camera-header">
                                    <div className="camera-title">
                                        <span aria-hidden="true">📷</span>
                                        CAMERA
                                        <span className="camera-live-dot" aria-label="Recording indicator" />
                                        FRONT VIEW
                                    </div>
                                    <button
                                        className={`camera-toggle-btn ${cameraOpen ? 'active' : ''}`}
                                        id="camera-toggle-btn"
                                        onClick={() => setCameraOpen(v => !v)}
                                        aria-expanded={cameraOpen}
                                        aria-controls="camera-feed-panel"
                                        aria-label={cameraOpen ? 'Hide camera feed' : 'Show camera feed'}
                                    >
                                        <span className="camera-toggle-icon" aria-hidden="true">▾</span>
                                        {cameraOpen ? 'HIDE' : 'SHOW'} FEED
                                    </button>
                                </div>

                                {/* Collapsible feed area */}
                                <div
                                    className="camera-feed-panel"
                                    id="camera-feed-panel"
                                    role="region"
                                    aria-label="Live camera feed"
                                >
                                    <div className="camera-view">
                                        {/* Placeholder — replace `src` with your MJPEG/WebRTC stream */}
                                        {/* <img src="/api/camera_stream" alt="UGV front camera live feed" /> */}
                                        <div className="camera-no-signal" aria-label="No video signal">
                                            <div className="camera-no-signal-icon" aria-hidden="true">📹</div>
                                            <span>NO SIGNAL</span>
                                        </div>
                                        <div className="camera-overlay" aria-hidden="true">
                                            <span className="camera-overlay-text">UGV-01 · FRONT · {clock}</span>
                                        </div>
                                    </div>
                                </div>
                            </div>

                        </div></Panel>
                </PanelGroup>
            </main>
        </div>
    );
}
