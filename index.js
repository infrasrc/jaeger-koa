const TEN_MINUTES_IN_MS = 10 * 60 * 1000;
const _ = require('lodash');
const compose = require('koa-compose');
const { Readable } = require('stream');

const Tracer = require('jaeger-tracer');
const { Tags, FORMAT_HTTP_HEADERS, globalTracer } = Tracer.opentracing;
const tracer = globalTracer();
let _logger = null;

if (!tracer) throw 'please set globalTracer before starting jaeger-koa';

class StringStream extends Readable {
    constructor(str, options) {
        super(options);
        this.str = str;
    };

    _read(size) {
        this.push(this.str);
        this.push(null);
    }
}


const _getBody = (ctx) => {
    const bodyStream = _.get(ctx, 'body', {});
    if ((typeof bodyStream.on !== 'function') && !(bodyStream instanceof Readable)) return Promise.resolve(bodyStream);
    const chunks = []
    return new Promise((resolve, reject) => {
        bodyStream.on('data', chunk => chunks.push(chunk));
        bodyStream.on('error', reject);
        bodyStream.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            ctx.body = new StringStream(body);
            resolve(body);
        });
    });
};

const _finishSpan = (ctx) => {
    const span = _.get(ctx, 'span', null);
    if (!span) throw 'span not found';
    const spanTimeout = _.get(ctx, 'spanTimeout', null);
    if (spanTimeout) clearTimeout(spanTimeout);
    span.finish();
    delete ctx.span;
}

const _setTimeout = (ctx) => {
    return new Promise((resolve) => {
        ctx.spanTimeout = setTimeout(() => {
            _finishSpan(ctx);
            resolve('timeout');
        }, TEN_MINUTES_IN_MS);
    });
}

const _logError = (message, error) => {
    if (_logger && _logger.error instanceof Function) _logger.error(message, error);
}

class KoaJaeger {

    constructor() {
        this.handler = this.handler.bind(this);
        this.start = this.start.bind(this);
        this.end = this.end.bind(this);
    }

    handler(...args) {
        let router = null;
        try {
            const routerIndex = _.findIndex(args, (arg) => (arg.constructor.name === 'Router') ? true : false);
            router = args[routerIndex];
            let beforeMiddlewaresRouter = _.chain(args).slice(0, routerIndex).filter((arg) => (arg instanceof Function) ? true : false).value();
            let afterMiddlewaresRouter = _.chain(args).slice(routerIndex + 1).filter((arg) => (arg instanceof Function) ? true : false).value();
            _.each(router.stack, (v) => {
                v.stack = [...beforeMiddlewaresRouter, compose([this.start, ...v.stack, this.end], ...afterMiddlewaresRouter)];
            });
        } catch (error) {
            _logError(error.message, error);
            throw error;
        }
        return router;
    };

    static errorHandler(error, ctx) {
        try {
            const span = _.get(ctx, 'span', null);
            if (!span) throw 'span not found';
            span.setTag(Tags.ERROR, true);
            span.setTag(Tags.HTTP_STATUS_CODE, ctx.status);
            span.log({
                event: 'error',
                message: error.message,
                stack: error.stack
            });
            _finishSpan(ctx);
        } catch (error) {
            _logError(error.message, error);
        }
    };

    async start(ctx, next) {
        try {
            const email = _.get(ctx, 'state.user.email', null);
            const params = _.get(ctx, 'params', {});
            const query = _.get(ctx, 'query', null);
            const method = _.get(ctx, 'method', '');
            const headers = _.get(ctx, 'headers', null);
            const routePath = _.get(ctx, '_matchedRoute', '');
            const name = `${method} ${routePath.substring(1)}`;
            const parentSpanContext = tracer.extract(FORMAT_HTTP_HEADERS, headers);
            const spanOptions = {};

            if (parentSpanContext) spanOptions.childOf = parentSpanContext;

            _setTimeout(ctx);

            ctx.span = tracer.startSpan(name, spanOptions);

            ctx.span.setTag(Tags.SPAN_KIND, Tags.SPAN_KIND_RPC_SERVER);

            if (email) ctx.span.setTag('user.email', email);

            _.each(params, (paramValue, paramName) => {
                ctx.span.setTag(`param.${paramName}`, paramValue);
            });

            _.each(query, (queryValue, queryName) => {
                ctx.span.setTag(`query.${queryName}`, queryValue);
            });

        } catch (error) {
            _logError(error.message, error);
            ctx.app.emit('error', error, ctx);
        }
        return next();
    };

    async end(ctx) {
        try {                        
            const span = _.get(ctx, 'span', null);
            if (!span) throw 'span not found';

            const body = await _getBody(ctx);
            span.log({
                'event': 'response',
                'value': body
            });
            _finishSpan(ctx);
        } catch (error) {
            _finishSpan(ctx);
            _logError(error.message, error);
            ctx.app.emit('error', error, ctx);
        }
    };
}

module.exports = (Koa, Logger) => {
    _logger = Logger;

    const emit = Koa.prototype.emit;

    Koa.prototype.emit = function (...args) {
        const error = args[1];
        args[1] = (error instanceof Error) ? error : new Error(error);
        return emit.call(this, ...args);
    };

    Koa.prototype.KoaJaeger = KoaJaeger;

    return Koa;
}