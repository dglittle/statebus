(function () {
    var unique_sockjs_string = '_connect_to_statebus_'

    // ****************
    // Connecting over the Network
    function set_cookie (key, val) {
        document.cookie = key + '=' + val + '; Expires=21 Oct 2025 00:0:00 GMT;'
    }
    function get_cookie (key) {
        var c = document.cookie.match('(^|;)\\s*' + key + '\\s*=\\s*([^;]+)');
        return c ? c.pop() : '';
    }
    try { document.cookie } catch (e) {get_cookie = set_cookie = function (){}}
    function sockjs_client (prefix, url) {
	var bus = this;

        function socket_api (url) {
            if (!url.match(/^\w{0,7}:\/\//))
                url = location.protocol+'//'+location.hostname+(location.port ? ':'+location.port : '') + url

            url = url.replace(/^state:\/\//, 'wss://')
            url = url.replace(/^istate:\/\//, 'http://')
            url = url.replace(/^statei:\/\//, 'http://')
            // {   // Convert to absolute
            //     var link = document.createElement("a")
            //     link.href = url
            //     url = link.href
            // }
            url = url.replace(/^http:\/\//, 'ws://')
            url = url.replace(/^https:\/\//, 'wss://')
            console.log('opening websocket to', url)
            return new WebSocket(url + '/' + unique_sockjs_string + '/websocket')
        }
        function socket_api_sjs (url) {
            url = url.replace(/^state:\/\//, 'https://')
            url = url.replace(/^istate:\/\//, 'http://')
            url = url.replace(/^statei:\/\//, 'http://')
            return new SockJS(url + '/' + unique_sockjs_string)
        }
        function login (send_login_info) {
            // Warning:
            //
            //  - This is giving every domain we connect to the secret client
            //    key from the site that *loaded this page*.  If you don't
            //    trust a site you're connecting to, you're basically letting
            //    them log in as you into the site you loaded this page from.
            //
            //  Let's implement a better distributed auth.  In fact, we'd
            //  probably prefer to NOT send login info to these third-party
            //  sites than sending them our secret client id for another site.
            //  Perhaps our best interim solution is to hold different client
            //  secrets for every domain we connect to, within each domain's
            //  localStorage space.
            
            var me = bus.fetch('ls/me')
            bus.log('connect: me is', me)
            if (!me.client) {
                // Create a client id if we have none yet.
                // Either from a cookie set by server, or a new one from scratch.
                var c = get_cookie('client')
                me.client = c || (Math.random().toString(36).substring(2)
                                  + Math.random().toString(36).substring(2)
                                  + Math.random().toString(36).substring(2))
                bus.save(me)
            }

            set_cookie('client', me.client)
            send_login_info(me.client)
        }
        bus.net_client(prefix, url, socket_api, login)
        bus.go_net(socket_api, login)
    }

    function localstorage_client (prefix) {
        try { localStorage } catch (e) { return }

        // This doesn't yet trigger updates across multiple browser windows.
        // We can do that by adding a list of dirty keys and 

        var bus = this
        bus.log(this)

        // Fetch returns the value immediately in a save
        // Saves are queued up, to store values with a delay, in batch
        var saves_are_pending = false
        var pending_saves = {}

        function save_the_pending_saves() {
            bus.log('localstore: saving', pending_saves)
            for (var k in pending_saves)
                localStorage.setItem(k, JSON.stringify(pending_saves[k]))
            saves_are_pending = false
        }

        bus(prefix).to_fetch = function (key) {
            var result = localStorage.getItem(key)
            return result ? JSON.parse(result) : {key: key}
        }
        bus(prefix).to_save = function (obj) {
            // Do I need to make this recurse into the object?
            bus.log('localStore: on_save:', obj.key)
            pending_saves[obj.key] = obj
            if (!saves_are_pending) {
                setTimeout(save_the_pending_saves, 50)
                saves_are_pending = true
            }
            bus.save.fire(obj)
            return obj
        }
        bus(prefix).to_delete = function (key) { localStorage.removeItem(key) }


        // Hm... this update stuff doesn't seem to work on file:/// urls in chrome
        function update (event) {
            bus.log('Got a localstorage update', event)
            //this.get(event.key.substr('statebus '.length))
        }
        if (window.addEventListener) window.addEventListener("storage", update, false)
        else                         window.attachEvent("onstorage", update)
    }

    // Stores state in the query string, as ?key1={obj...}&key2={obj...}
    function url_store (prefix) {
        var bus = this
        function get_query_string_value (key) {
            return unescape(window.location.search.replace(
                new RegExp("^(?:.*[&\\?]"
                           + escape(key).replace(/[\.\+\*]/g, "\\$&")
                           + "(?:\\=([^&]*))?)?.*$", "i"),
                "$1"))
        }

        // Initialize data from the URL on load
        
        // Now the regular shit
        var data = get_query_string_value(key)
        data = (data && JSON.parse(data)) || {key : key}
        // Then I would need to:
        //  - Change the key prefix
        //  - Save this into the cache

        bus(prefix).to_save = function (obj) {
            window.history.replaceState(
                '',
                '',
                document.location.origin
                    + document.location.pathname
                    + escape('?'+key+'='+JSON.stringify(obj)))
            bus.save.fire(obj)
        }
    }

    function live_reload_from (prefix) {
        if (!window.live_reload_initialized) {
            var first_time = true
            this(function () {
                var re = new RegExp(".*/" + prefix + "/(.*)")
                var file = window.location.href.match(re)[1]
                var code = bus.fetch('/code/invisible.college/' + file).code
                if (!code) return
                if (first_time) {first_time = false; return}
                var old_scroll_position = window.pageYOffset
                document.body.innerHTML = code
                var i = 0
                var d = 100
                var interval = setInterval(function () {
                    if (i > 500) clearInterval(interval)
                    i += d
                    window.scrollTo(0, old_scroll_position)
                }, d)
            })
            window.live_reload_initialized = true
        }
    }

    // ****************
    // Wrapper for React Components

    // XXX Currently assumes there's a statebus named "bus" in global
    // XXX scope.

    var components = {}                  // Indexed by 'component/0', 'component/1', etc.
    var components_count = 0
    var dirty_components = {}
    function React_View(component) {
        function wrap(name, new_func) {
            var old_func = component[name]
            component[name] = function wrapper () { return new_func.bind(this)(old_func) }
        }
        
        // Register the component's basic info
        wrap('componentWillMount', function new_cwm (orig_func) {
            if (component.displayName === undefined)
                throw 'Component needs a displayName'
            this.name = component.displayName.toLowerCase().replace(' ', '_')
            this.key = 'component/' + components_count++
            components[this.key] = this

            function add_shortcut (obj, shortcut_name, to_key) {
                delete obj[shortcut_name]
                Object.defineProperty(obj, shortcut_name, {
                    get: function () { return bus.fetch(to_key) },
                    configurable: true })
            }
            add_shortcut(this, 'local', this.key)

            orig_func && orig_func.apply(this, arguments)

            // Make render reactive
            var orig_render = this.render
            this.render = bus.reactive(function () {
                console.assert(this !== window)
                if (this.render.called_directly) {
                    delete dirty_components[this.key]

                    // Add reactivity to any keys passed inside objects in props.
                    for (var k in this.props)
                        if (this.props.hasOwnProperty(k)
                            && this.props[k] !== null
                            && typeof this.props[k] === 'object'
                            && this.props[k].key)
                            
                            bus.fetch(this.props[k].key)
                    
                    // Call the renderer!
                    return orig_render.apply(this, arguments)
                } else {
                    dirty_components[this.key] = true
                    schedule_re_render()
                }
            })
        })

        wrap('componentWillUnmount', function new_cwu (orig_func) {
            orig_func && orig_func.apply(this, arguments)
            // Clean up
            bus.delete(this.key)
            delete components[this.key]
            delete dirty_components[this.key]
        })

        function shallow_clone(original) {
            var clone = Object.create(Object.getPrototypeOf(original))
            var i, keys = Object.getOwnPropertyNames(original)
            for (i=0; i < keys.length; i++){
                Object.defineProperty(clone, keys[i],
                    Object.getOwnPropertyDescriptor(original, keys[i])
                )
            }
            return clone
        }

        component.shouldComponentUpdate = function new_scu (next_props, next_state) {
            // This component definitely needs to update if it is marked as dirty
            if (dirty_components[this.key] !== undefined) return true

            // Otherwise, we'll check to see if its state or props
            // have changed.  But ignore React's 'children' prop,
            // because it often has a circular reference.
            next_props = shallow_clone(next_props)
            this_props = shallow_clone(this.props)

            delete next_props['children']; delete this_props['children']
            // delete next_props['kids']; delete this_props['kids']

            next_props = bus.clone(next_props)
            this_props = bus.clone(this_props)
            

            return !bus.deep_equals([next_state, next_props], [this.state, this_props])

            // TODO:
            //
            //  - Check children too.  Right now we just silently fail
            //    on components with children.  WTF?
            //
            //  - A better method might be to mark a component dirty when
            //    it receives new props in the
            //    componentWillReceiveProps React method.
        }
        
        component.loading = function loading () {
            return this.render.loading()
        }

        // Now create the actual React class with this definition, and
        // return it.
        var react_class = React.createClass(component)
        var result = function (props, children) {
            props = props || {}
            props['data-key'] = props.key
            props['data-widget'] = component.displayName

            return (React.version >= '0.12.'
                    ? React.createElement(react_class, props, children)
                    : react_class(props, children))
        }
        // Give it the same prototype as the original class so that it
        // passes React.isValidClass() inspection
        result.prototype = react_class.prototype
        return result
    }
    window.React_View = React_View


    // *****************
    // Re-rendering react components
    var re_render_scheduled = false
    re_rendering = false
    function schedule_re_render() {
        if (!re_render_scheduled) {
            requestAnimationFrame(function () {
                re_render_scheduled = false

                // Re-renders dirty components
                for (var comp_key in dirty_components) {
                    if (dirty_components[comp_key] // Since another component's update might update this
                        && components[comp_key])   // Since another component might unmount this

                        try {
                            re_rendering = true
                            components[comp_key].forceUpdate()
                        } finally {
                            re_rendering = false
                        }
                }
            })
            re_render_scheduled = true
        }
    }

    // ##############################################################################
    // ###
    // ###  Full-featured single-file app methods
    // ###

    function make_client_statebus_maker () {
        var extra_stuff = ['sockjs_client localstorage_client',
                           'url_store components live_reload_from'].join(' ').split(' ')
        if (window.statebus) {
            var orig_statebus = statebus
            window.statebus = function make_client_bus () {
                var bus = orig_statebus()
                for (var i=0; i<extra_stuff.length; i++)
                    bus[extra_stuff[i]] = eval(extra_stuff[i])
                bus.localstorage_client('ls/*')
                return bus
            }
        }
    }

    load_scripts() // This function could actually be inlined
    function load_scripts() {
        // console.info('Loading scripts!', window.statebus)
        if (!window.statebus) {
            var statebus_dir = script_elem().getAttribute('src').match(/(.*)[\/\\]/)
            statebus_dir = (statebus_dir && statebus_dir[1] + '/')||''

            var js_urls = {
                react: statebus_dir + 'extras/react.js',
                sockjs: statebus_dir + 'extras/sockjs.js',
                coffee: statebus_dir + 'extras/coffee.js',
                statebus: statebus_dir + 'statebus.js'
            }
            if (statebus_dir == 'https://stateb.us/')
                js_urls.statebus = statebus_dir + 'statebus4.js'

            for (var name in js_urls)
                document.write('<script src="' + js_urls[name] + '" charset="utf-8"></script>')
        }

        document.addEventListener('DOMContentLoaded', scripts_ready, false)
    }

    function script_elem () {
        return document.querySelector('script[src*="client"][src$=".js"]')
    }
    var loaded_from_file_url = window.location.href.match(/^file:\/\//)
    window.statebus_server = window.statebus_server ||
        script_elem().getAttribute('server') ||
        (loaded_from_file_url ? 'https://stateb.us:3006' : '/')
    window.statebus_backdoor = window.statebus_backdoor ||
        script_elem().getAttribute('backdoor')
    var react_render
    function scripts_ready () {
        react_render = React.version >= '0.14.' ? ReactDOM.render : React.render
        make_client_statebus_maker()
        window.bus = window.statebus()
        window.bus.label = 'bus'
        window.sb = bus.sb
        statebus.widget = React_View

        improve_react()
        window.dom = window.ui = window.dom || window.ui || {}
        window.ignore_flashbacks = false
        if (statebus_server !== 'none')
            bus.sockjs_client ('/*', statebus_server)

        if (window.statebus_backdoor) {
            window.master = statebus()
            master.sockjs_client('*', statebus_backdoor)
        }

        // bus('*').to_save = function (obj) { bus.save.fire(obj) }
        bus('/new/*').to_save = function (o) {
            if (o.key.split('/').length > 3) return

            var old_key = o.key
            o.key = old_key + '/' + Math.random().toString(36).substring(2,12)
            statebus.cache[o.key] = o
            delete statebus.cache[old_key]
            bus.save(o)
        }
        load_coffee()

        statebus.compile_coffee = compile_coffee
        statebus.load_client_code = load_client_code
        statebus.load_widgets = load_widgets

        if (window.statebus_ready)
            for (var i=0; i<statebus_ready.length; i++)
                statebus_ready[i]()

        load_widgets()
        // if (dom.Body || dom.body || dom.BODY)
        //     react_render((window.Body || window.body || window.BODY)(), document.body)
    }

    function improve_react() {
        function capitalize (s) {return s[0].toUpperCase() + s.slice(1)}
        function camelcase (s) { var a = s.split(/[_-]/)
                                 return a.slice(0,1).concat(a.slice(1).map(capitalize)).join('') }

        var all_css_props = Object.keys(document.body.style)
        var ignore = {d:1, cx:1, cy:1, rx:1, ry:1, x:1, y:1,
                      content:1, fill:1, stroke:1, src:1}
        var is_css_prop = {}
        for (var i=0; i<all_css_props.length; i++)
            if (!ignore[all_css_props[i]])
                is_css_prop[all_css_props[i]] = true

        function better_element(el) {
            // To do:
            //  - Don't put all args into a children array, cause react thinks
            //    that means they need a key.

            return function () {
                var children = []
                var attrs = {style: {}}
                
                for (var i=0; i<arguments.length; i++) {
                    var arg = arguments[i]

                    // Strings and DOM nodes and undefined become children
                    if (typeof arg === 'string'   // For "foo"
                        || arg instanceof String  // For new String()
                        || arg && React.isValidElement(arg)
                        || arg === undefined)
                        children.push(arg)

                    // Arrays append onto the children
                    else if (arg instanceof Array)
                        Array.prototype.push.apply(children, arg)

                    // Pure objects get merged into object city
                    // Styles get redirected to the style field
                    else if (arg instanceof Object)
                        for (var k in arg)
                            if (is_css_prop[k]
                                && !(k in {width:1,height:1,size:1}
                                     && el in {canvas:1, input:1, embed:1, object:1}))
                                attrs.style[k] = arg[k]        // Merge styles
                            else if (k === 'style')            // Merge insides of style tags
                                for (var k2 in arg[k])
                                    attrs.style[k2] = arg[k][k2]
                            else {
                                attrs[k] = arg[k]          // Or be normal.

                                if (k === 'key')
                                    attrs['data-key'] = arg[k]
                            }
                }
                if (children.length === 0) children = undefined
                if (attrs['ref'] === 'input')
                    bus.log(attrs, children)
                return React.DOM[el](attrs, children)
            }
        }
        for (var el in React.DOM)
            window[el.toUpperCase()] = better_element(el)
        
        function make_better_input (name, element) {
            window[name] = React.createFactory(React.createClass({
                getInitialState: function() {
                    return {value: this.props.value}
                },
                componentWillReceiveProps: function(new_props) {
                    this.setState({value: new_props.value})
                },
                onChange: function(e) {
                    this.props.onChange && this.props.onChange(e)
                    if (this.props.value)
                        this.setState({value: e.target.value})
                },
                render: function() {
                    var new_props = {}
                    for (var k in this.props)
                        if (this.props.hasOwnProperty(k))
                            new_props[k] = this.props[k]
                    if (this.state.value) new_props.value = this.state.value
                    new_props.onChange = this.onChange
                    return element(new_props)
                }
            }))
        }

        make_better_input("INPUT", window.INPUT)
        make_better_input("TEXTAREA", window.TEXTAREA)

        // Unfortunately, React's default STYLE and TITLE tags are useless
        // unless you "dangerously set inner html" because they wrap strings
        // inside useless spans.
        function escape_html (s) {
            // TODO: this will fail on '<' and '>' in CSS selectors
            return s.replace(/</g, "&lt;").replace(/>/g, "&gt;")
        }
        window.STYLE = function (s) {
            return React.DOM.style({dangerouslySetInnerHTML: {__html: escape_html(s)}})
        }
        window.TITLE = function (s) {
            return React.DOM.title({dangerouslySetInnerHTML: {__html: escape_html(s)}})
        }
    }

    function autodetect_args (func) {
        if (func.args) return

        // Get an array of the func's params
        var comments = /((\/\/.*$)|(\/\*[\s\S]*?\*\/))/mg,
            params = /([^\s,]+)/g,
            s = func.toString().replace(comments, '')
        func.args = s.slice(s.indexOf('(')+1, s.indexOf(')')).match(params) || []
    }


    // Load the components
    var users_widgets = {}
    function make_component(name, safe_renders) {
        // Define the component

        window[name] = users_widgets[name] = window.React_View({
            displayName: name,
            render: function () {
                var args = [], func = window.dom[name]

                // Parse the function's args, and pass props into them directly
                autodetect_args(func)
                // this.props.kids = this.props.kids || this.props.children
                for (var i=0; i<func.args.length; i++)
                    args.push(this.props[func.args[i]])

                // Now run the function.
                var vdom
                if (safe_renders)
                    try {
                        vdom = func.apply(this, args)
                    } catch (error) {
                        console.error(error)
                    }
                else  // TODO: kill support for this safe_renders = false branch?
                    vdom = func.apply(this, args)

                // This automatically adds two attributes "data-key" and
                // "data-widget" to the root node of every react component.
                // I think we might wanna find a better solution.
                if (vdom && vdom.props) {
                    vdom.props['data-widget'] = name
                    vdom.props['data-key'] = this.props['data-key']
                }

                // Wrap plain JS values with SPAN, so react doesn't complain
                if (!React.isValidElement(vdom))
                    // To do: should arrays be flattened into a SPAN's arguments?
                    vdom = React.DOM.span(null, (typeof vdom === 'string')
                                          ? vdom : JSON.stringify(vdom))
                return vdom
            },
            componentDidMount: function () {
                var refresh = window.dom[name].refresh
                refresh && refresh.bind(this)()
            },
            componentWillUnmount: function () {
                var down = window.dom[name].down
                return down && down.bind(this)()
            },
            componentDidUpdate: function () {
                if (!this.initial_render_complete && !this.loading()) {
                    this.initial_render_complete = true
                    var up = window.dom[name].up
                    up && up.bind(this)()
                }
                var refresh = window.dom[name].refresh
                return refresh && refresh.bind(this)()
            },
            getInitialState: function () { return {} }
        })
    }

    function compile_coffee (coffee, filename) {
        var compiled
        try {
            compiled = CoffeeScript.compile(coffee,
                                            {bare: true,
                                             sourceMap: true,
                                             filename: filename})
            var source_map = JSON.parse(compiled.v3SourceMap)
            source_map.sourcesContent = coffee
            compiled = compiled.js

            // Base64 encode the source map
            try {
                compiled += '\n'
                compiled += '//# sourceMappingURL=data:application/json;base64,'
                compiled += btoa(JSON.stringify(source_map)) + '\n'
                compiled += '//# sourceURL=' + filename
            } catch (e) {}  // btoa() fails on unicode. Give up for now.

        } catch (error) {
            if (error.location)
                console.error('Syntax error in '+ filename + ' on line',
                              error.location.first_line
                              + ', column ' + error.location.first_column + ':',
                              error.message)
            else throw error
        }
        return compiled
    }
    function load_client_code (code, safe) {
        var dom = {}, ui = {}
        if (code) eval(code)
        else { dom = window.dom; ui = window.ui }
        for (var k in ui) dom[k] = dom[k] || ui[k]
        for (var view in dom) {
            window.dom[view] = dom[view]
            make_component(view, safe)
        }
    }
    function load_coffee () {
        load_client_code()
        var scripts = document.getElementsByTagName("script")
        var filename = location.pathname.substring(location.pathname.lastIndexOf('/') + 1)
        for (var i=0; i<scripts.length; i++)
            if (scripts[i].getAttribute('type')
                in {'statebus':1, 'coffeedom':1,'statebus-js':1,
                    'coffee':1, 'coffeescript':1}) {
                // Compile coffeescript to javascript
                var compiled = scripts[i].text
                if (scripts[i].getAttribute('type') !== 'statebus-js')
                    compiled = compile_coffee(scripts[i].text, filename)
                if (compiled)
                    load_client_code(compiled)
            }
    }

    function dom_to_widget (node) {
        if (node.nodeName === '#text') return node.textContent

        node.seen = true
        var children = [], props = {}
        // Recursively convert children
        for (var i=0; i<node.childNodes.length; i++)
            children.push(dom_to_widget(node.childNodes[i]))  // recurse

        // Convert attributes to props
        var props = {}
        for (var i=0; node.attributes && i<node.attributes.length; i++)
            props[node.attributes[i].name] = node.attributes[i].value

        var widge = (window[node.nodeName.toLowerCase()]
                     || window[node.nodeName.toUpperCase()])
        console.assert(widge, node.nodeName + ' has not been defined as a UI widget.')

        return widge(props, children)
    }

    window.users_widgets = users_widgets
    function load_widgets () {
        for (var w in users_widgets) {
            var nodes = document.getElementsByTagName(w)
            for (var i=0; i<nodes.length; i++)
                if (!nodes[i].seen)
                    react_render(dom_to_widget(nodes[i]), nodes[i])
        }
    }
})()
