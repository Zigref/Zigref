import { useEffect, useRef, useState } from 'preact/hooks';
import { render } from 'preact';
import Prism from 'prismjs';
import 'prismjs/themes/prism-twilight.css';
import 'prismjs/components/prism-zig';

const isFolder = (value) => {
    return typeof value === 'object' && value !== null;
};

const HF_BUCKET_BASE = 'https://huggingface.co/buckets/Zigref/Zigref/resolve/database';
const SEARCH_API_BASE = 'https://api.zigref.dev';

async function fetch_repo_search(q, signal) {
    const res = await fetch(`${SEARCH_API_BASE}/search?q=${encodeURIComponent(q)}`, { signal });

    const data = await res.json();

    if (!res.ok) {
        throw new Error(`search failed.`);
    }

    return data.results || [];
}

function useRepoSearch() {
    const [results, set_results] = useState(null);
    const [loading, set_loading] = useState(false);
    const [error, set_error] = useState(null);
    const [searchedQuery, set_searched_query] = useState('');
    const controllerRef = useRef(null);

    useEffect(() => {
        return () => {
            if (controllerRef.current) {
                controllerRef.current.abort();
            }
        };
    }, []);

    const search = async (rawQuery) => {
        const q = rawQuery?.trim();
        set_searched_query(q || '');

        if (!q) {
            set_results(null);
            set_loading(false);
            set_error(null);
            return;
        }

        if (q.length > 30) {
            set_results([]);
            set_loading(false);
            set_error('query entered is more than 30 characters.');
            return;
        }

        if (controllerRef.current) {
            controllerRef.current.abort();
        }
        const controller = new AbortController();
        controllerRef.current = controller;

        set_loading(true);
        set_error(null);

        try {
            const data = await fetch_repo_search(q, controller.signal);
            set_results(data);
        } catch (e) {
            if (e.name !== 'AbortError') {
                set_results([]);
                set_error(e.message);
            }
        } finally {
            if (controllerRef.current === controller) {
                set_loading(false);
            }
        }
    };

    return { results, loading, error, searchedQuery, search };
}

function SearchResultList({ results, loading, error, query }) {
    const q = query?.trim();
    if (!q) return null;
    if (loading) return <p style={{ fontSize: 'small', opacity: 0.7 }}>Searching...</p>;
    if (error) return <p style={{ fontSize: 'small', opacity: 0.7 }}>{error}</p>;
    if (!results) return <></>;
    if (results.length === 0) return <p style={{ fontSize: 'small', opacity: 0.7 }}>No repos found for "{q}".</p>;
    return (
        <ul className="search-results">
            {results.map((result) => (
                <li key={result}>
                    <a href={`/${result}`}>{result}</a>
                </li>
            ))}
        </ul>
    );
}

function parseRepoPath(pathname) {
    const parts = pathname
        .split('/')
        .filter(Boolean)
        .map((p) => {
            try {
                return decodeURIComponent(p);
            } catch {
                return p;
            }
        });
    if (parts.length !== 3) return null;
    const [provider, owner, repo] = parts;
    if (provider !== 'gh' && provider !== 'cb') return null;
    if (!owner || !repo) return null;
    return { provider, owner, repo };
}

async function decodeBrBuffer(buf) {
    try {
        const ds = new DecompressionStream('br');
        const stream = new Blob([buf]).stream().pipeThrough(ds);
        const text = await new Response(stream).text();
        if (text && text.length > 0) return text;
    } catch (_) {
        // Native brotli DecompressionStream not supported (e.g. Chrome), fall through to wasm.
    }
    const mod = await import('brotli-wasm');
    const brotli = await mod.default;
    const out = brotli.decompress(new Uint8Array(buf));
    return new TextDecoder().decode(out);
}

async function fetchDocsBr(provider, owner, repo) {
    const url = `${HF_BUCKET_BASE}/${provider}/${owner}/${repo}.br`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Docs not found for ${provider}/${owner}/${repo} (${res.status})`);
    const buf = await res.arrayBuffer();
    const sizeKiB = (buf.byteLength / 1024).toFixed(2);
    let text;
    try {
        text = await decodeBrBuffer(buf);
    } catch (_) {
        // Backend writes plain JSON with a .br extension when docs exceed the limit.
        text = new TextDecoder().decode(buf);
    }
    const data = JSON.parse(text);
    if (data.error) throw new Error(data.error);
    return { data, sizeKiB };
}

function build_source_url(provider, owner, repo, commit_hash, file_path, line_number) {
    if (!provider || !owner || !repo || !file_path) return null;

    const path_which_is_encoded = file_path
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');

    const the_line_number_part = line_number != null ? `#L${line_number}` : '';

    if (provider === 'gh') {
        const ref = commit_hash || 'HEAD';
        return `https://github.com/${owner}/${repo}/blob/${ref}/${path_which_is_encoded}${the_line_number_part}`;
    }

    if (provider === 'cb') {
        if (commit_hash) {
            return `https://codeberg.org/${owner}/${repo}/src/commit/${commit_hash}/${path_which_is_encoded}${the_line_number_part}`;
        } else {
            return `https://codeberg.org/${owner}/${repo}/src/branch/main/${path_which_is_encoded}${the_line_number_part}`;
        }
    }

    return null;
}

function RenderComponent({ component, prefix, repo_info, file_path, commit_hash }) {
    const full_name = prefix ? `${prefix}::${component.name}` : component.name;
    const component_id = full_name.replace(/::/g, '--');
    const source_url =
        repo_info && file_path
            ? build_source_url(
                  repo_info.provider,
                  repo_info.owner,
                  repo_info.repo,
                  commit_hash,
                  file_path,
                  component.line_number
              )
            : null;
    const source_label = repo_info?.provider === 'cb' ? 'Open file on Codeberg' : 'Open file on GitHub';
    return (
        <div className="box" id={component_id}>
            <h3>
                <span className="component_type">{component.type}</span>{' '}
                <span className="component_name">{full_name}</span>:
                <span className="line_number">{component.line_number}</span>{' '}
                <a className="link-icon" href={`#${component_id}`} title="Copy link to this item">
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        class="lucide lucide-link-icon lucide-link"
                    >
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                    </svg>
                </a>{' '}
                {source_url && (
                    <a
                        className="link-icon"
                        href={source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={source_label}
                        aria-label={source_label}
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="lucide lucide-external-link-icon lucide-external-link"
                        >
                            <path d="M15 3h6v6" />
                            <path d="M10 14 21 3" />
                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                        </svg>
                    </a>
                )}
            </h3>
            <p>{component.comment}</p>
            {component.type === 'test' ? (
                <pre>
                    <code className="language-zig">test {component.name}</code>
                </pre>
            ) : (
                <pre>
                    <code className="language-zig">{component.partial_definition}</code>
                </pre>
            )}
        </div>
    );
}

function RenderNamespace({ namespace, prefix, repo_info, file_path, commit_hash }) {
    const ns_prefix = prefix ? `${prefix}::${namespace.name}` : namespace.name;
    return (
        <details className="namespace-section">
            <summary className="namespace-header">{namespace.name}</summary>
            <div className="namespace-body">
                {namespace.components &&
                    namespace.components.map((c, i) => (
                        <RenderComponent
                            key={i}
                            component={c}
                            prefix={ns_prefix}
                            repo_info={repo_info}
                            file_path={file_path}
                            commit_hash={commit_hash}
                        />
                    ))}
                {namespace.namespaces &&
                    namespace.namespaces.map((ns, i) => (
                        <RenderNamespace
                            key={i}
                            namespace={ns}
                            prefix={ns_prefix}
                            repo_info={repo_info}
                            file_path={file_path}
                            commit_hash={commit_hash}
                        />
                    ))}
            </div>
        </details>
    );
}

function RenderDocumentation({ data, repo_info, file_path, commit_hash }) {
    if (!data.components || data.components.length == 0) {
        return <>No documentation for this file!</>;
    }
    return (
        <>
            {data.components.map((c, i) => (
                <RenderComponent
                    key={i}
                    component={c}
                    prefix=""
                    repo_info={repo_info}
                    file_path={file_path}
                    commit_hash={commit_hash}
                />
            ))}
            {data.namespaces &&
                data.namespaces.map((ns, i) => (
                    <RenderNamespace
                        key={i}
                        namespace={ns}
                        prefix=""
                        repo_info={repo_info}
                        file_path={file_path}
                        commit_hash={commit_hash}
                    />
                ))}
        </>
    );
}

function TreeView({ tree, onSelect, path_of_the_parent = '' }) {
    const entries = Object.entries(tree).sort(([, a], [, b]) => {
        return Number(isFolder(b)) - Number(isFolder(a));
    });

    return (
        <ul>
            {entries.map(([name, value]) => {
                const complete_path = path_of_the_parent ? `${path_of_the_parent}/${name}` : name;
                return (
                    <div key={name}>
                        {isFolder(value) ? (
                            <details open>
                                <summary>
                                    <span
                                        style={{ display: 'flex', alignItems: 'center' }}
                                        className="file_folder_name"
                                    >
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width="15"
                                            height="15"
                                            viewBox="0 0 24 24"
                                            fill="none"
                                            stroke="currentColor"
                                            stroke-width="2"
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            class="lucide lucide-folder-icon lucide-folder"
                                        >
                                            <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                                        </svg>
                                        &nbsp;{name}&#47;
                                    </span>
                                </summary>
                                <TreeView tree={value} onSelect={onSelect} path_of_the_parent={complete_path} />
                            </details>
                        ) : (
                            <span
                                className="file_folder_name"
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    cursor: 'pointer',
                                }}
                                onClick={() => onSelect({ name: complete_path, path: complete_path, value })}
                            >
                                &nbsp; &nbsp;
                                <svg xmlns="http://www.w3.org/2000/svg" width={15} height={15} viewBox="0 0 153 140">
                                    <g fill="#f7a41d">
                                        <g>
                                            <polygon points="46,22 28,44 19,30" />
                                            <polygon
                                                points="46,22 33,33 28,44 22,44 22,95 31,95 20,100 12,117 0,117 0,22"
                                                shape-rendering="crispEdges"
                                            />
                                            <polygon points="31,95 12,117 4,106" />
                                        </g>
                                        <g>
                                            <polygon points="56,22 62,36 37,44" />
                                            <polygon
                                                points="56,22 111,22 111,44 37,44 56,32"
                                                shape-rendering="crispEdges"
                                            />
                                            <polygon points="116,95 97,117 90,104" />
                                            <polygon
                                                points="116,95 100,104 97,117 42,117 42,95"
                                                shape-rendering="crispEdges"
                                            />
                                            <polygon points="150,0 52,117 3,140 101,22" />
                                        </g>
                                        <g>
                                            <polygon points="141,22 140,40 122,45" />
                                            <polygon
                                                points="153,22 153,117 106,117 120,105 125,95 131,95 131,45 122,45 132,36 141,22"
                                                shape-rendering="crispEdges"
                                            />
                                            <polygon points="125,95 130,110 106,117" />
                                        </g>
                                    </g>
                                </svg>
                                &nbsp;{name}
                            </span>
                        )}
                    </div>
                );
            })}
        </ul>
    );
}

function Home() {
    const [query, setQuery] = useState('');
    const { results, loading, error, searchedQuery, search } = useRepoSearch();

    const handleSearch = () => {
        search(query);
    };

    return (
        <div className="content-wrapper centerize">
            <span className="block home-search-block">
                <h1>
                    <span style={{ color: 'yellow' }}>Zig</span>ref
                </h1>
                <h5>Search docs for multiple Zig packages.</h5>
                <input
                    autoFocus
                    placeholder="Search..."
                    className="input-text"
                    type="text"
                    value={query}
                    onInput={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            handleSearch();
                        }
                    }}
                />
                <div className="search-buttons">
                    <button
                        type="button"
                        className="search-btn"
                        onClick={() =>
                            window.open(
                                `https://zigistry.dev/search#search=${encodeURIComponent(query)}&type=packages&sort=stars&dir=desc&page=1`,
                                '_blank'
                            )
                        }
                    >
                        Search on Zigistry
                    </button>
                    <button type="button" className="search-btn" onClick={handleSearch}>
                        Search just that
                    </button>
                </div>
                <SearchResultList results={results} loading={loading} error={error} query={searchedQuery} />
            </span>
        </div>
    );
}

function HomeFooter() {
    return (
        <footer className="home-footer">
            <a href="https://zigistry.dev" target="_blank" rel="noopener noreferrer">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="lucide lucide-package-icon lucide-package"
                >
                    <path d="m7.5 4.27 9 5.15" />
                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                    <path d="m3.3 7 8.7 5 8.7-5" />
                    <path d="M12 22V12" />
                </svg>
                Zigistry
            </a>
            <a href="https://github.com/Zigref/Zigref" target="_blank" rel="noopener noreferrer">
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="lucide lucide-github-icon lucide-github"
                >
                    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                    <path d="M9 18c-4.51 2-5-2-7-2" />
                </svg>
                GitHub
            </a>
        </footer>
    );
}

function DocsFooter({ commit_hash, size_in_byte }) {
    return (
        <footer>
            <span>
                #{commit_hash} &nbsp;
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    class="lucide lucide-file-archive-icon lucide-file-archive"
                >
                    <path d="M13.659 22H18a2 2 0 0 0 2-2V8a2.4 2.4 0 0 0-.706-1.706l-3.588-3.588A2.4 2.4 0 0 0 14 2H6a2 2 0 0 0-2 2v11.5" />
                    <path d="M14 2v5a1 1 0 0 0 1 1h5" />
                    <path d="M8 12v-1" />
                    <path d="M8 18v-2" />
                    <path d="M8 7V6" />
                    <circle cx="8" cy="20" r="2" />
                </svg>
                {size_in_byte} KiB
            </span>
        </footer>
    );
}

function App() {
    const [tree, setTree] = useState();
    const [dataEntries, setDataEntries] = useState();
    const [commit_hash, setCommitHash] = useState();
    const [commit_hash_full, set_commit_hash_full] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(null);
    const [size_in_byte, set_size_in_byte] = useState(null);
    const [active_view, set_active_view] = useState('files');
    const [currentPath, setCurrentPath] = useState(window.location.pathname);
    const [is_loading, set_is_loading] = useState(false);
    const [fetch_error, set_fetch_error] = useState(null);
    const [repo_info, set_repo_info] = useState(null);

    useEffect(() => {
        const handleLocationChange = () => {
            setCurrentPath(window.location.pathname);
        };

        window.addEventListener('popstate', handleLocationChange);

        return () => {
            window.removeEventListener('popstate', handleLocationChange);
        };
    }, []);

    const is_home_page = currentPath === '/';

    useEffect(() => {
        Prism.highlightAll();
        if (location.hash) {
            setTimeout(() => {
                document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
            }, 100);
        }
    }, [selectedIndex]);
    useEffect(() => {
        const on_hash_change = () => {
            if (location.hash) {
                document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: 'smooth' });
            }
        };
        window.addEventListener('hash_has_changed', on_hash_change);
        return () => window.removeEventListener('hash_has_changed', on_hash_change);
    }, []);
    useEffect(() => {
        if (is_home_page) return;
        const parsed = parseRepoPath(currentPath);
        if (!parsed) {
            set_fetch_error(`Invalid docs path "${currentPath}". Expected /gh/{owner}/{repo} or /cb/{owner}/{repo}.`);
            setTree(undefined);
            setDataEntries(undefined);
            set_repo_info(null);
            return;
        }
        let cancelled = false;
        set_is_loading(true);
        set_fetch_error(null);
        setTree(undefined);
        setDataEntries(undefined);
        setSelectedIndex(null);
        set_repo_info(parsed);
        fetchDocsBr(parsed.provider, parsed.owner, parsed.repo)
            .then(({ data, sizeKiB }) => {
                if (cancelled) return;
                set_size_in_byte(sizeKiB);
                setTree(data.metadata.project_tree);
                const full_hash = data.metadata.commit_hash || '';
                set_commit_hash_full(full_hash);
                setCommitHash(full_hash ? full_hash.slice(0, 10) + '...' : '');
                setDataEntries(data.data);
            })
            .catch((e) => {
                if (cancelled) return;
                set_fetch_error(e.message);
            })
            .finally(() => {
                if (!cancelled) set_is_loading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [currentPath, is_home_page]);

    if (is_home_page) {
        return (
            <div>
                <nav>
                    <a href="/" style={{ color: 'white', textDecoration: 'none' }}>
                        <span style={{ color: 'yellow' }}>Zig</span>ref
                    </a>
                </nav>
                <Home />
                <HomeFooter />
            </div>
        );
    }

    return (
        <div>
            <nav>
                <a href="/" style={{ color: 'white', textDecoration: 'none' }}>
                    <span style={{ color: 'yellow' }}>Zig</span>ref
                </a>
                <input className="search_text" type="text" />
            </nav>
            <div class="content-wrapper">
                <aside id="side-side-bar">
                    <button
                        class={`sidebar-btn ${active_view === 'files' ? 'active' : ''}`}
                        onClick={() => set_active_view('files')}
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="lucide lucide-folder-open-icon lucide-folder-open"
                        >
                            <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                        </svg>
                    </button>
                    <button
                        class={`sidebar-btn ${active_view === 'search' ? 'active' : ''}`}
                        onClick={() => set_active_view('search')}
                    >
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="24"
                            height="24"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="lucide lucide-search-icon lucide-search"
                        >
                            <path d="m21 21-4.34-4.34" />
                            <circle cx="11" cy="11" r="8" />
                        </svg>
                    </button>
                </aside>
                <aside id="sidebar">
                    {active_view === 'files' ? (
                        <>
                            <h5 id="mention_title">File Explorer</h5>
                            {repo_info && (
                                <p style={{ fontSize: 'small', opacity: 0.7 }}>
                                    {repo_info.provider}/{repo_info.owner}/{repo_info.repo}
                                </p>
                            )}
                            {fetch_error ? (
                                <p>{fetch_error}</p>
                            ) : tree ? (
                                <TreeView tree={tree} onSelect={setSelectedIndex} />
                            ) : (
                                'Loading…'
                            )}
                        </>
                    ) : (
                        <>
                            <h5 id="mention_title">Search</h5>
                        </>
                    )}
                </aside>

                <main>
                    {is_loading ? (
                        <p>Loading docs…</p>
                    ) : fetch_error ? (
                        <p>{fetch_error}</p>
                    ) : selectedIndex !== null ? (
                        <>
                            <h2>
                                Showing documentation for file:{' '}
                                <span className="line_number">{selectedIndex.name}</span>
                            </h2>
                            {selectedIndex.value != null && dataEntries ? (
                                <RenderDocumentation
                                    key={selectedIndex.value}
                                    data={dataEntries[selectedIndex.value]}
                                    repo_info={repo_info}
                                    file_path={selectedIndex.path || selectedIndex.name}
                                    commit_hash={commit_hash_full}
                                />
                            ) : (
                                <p>Select a file</p>
                            )}
                        </>
                    ) : (
                        <p>Select a file</p>
                    )}
                </main>
            </div>
            <DocsFooter commit_hash={commit_hash} size_in_byte={size_in_byte} />
        </div>
    );
}

render(<App />, document.getElementById('app'));
