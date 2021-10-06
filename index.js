import * as maptalks from 'maptalks';

const options = {
    'maxClusterRadius' : 160,
    'textSumProperty' : null,
    'symbol' : null,
    'drawClusterText' : true,
    'textSymbol' : null,
    'animation' : true,
    'animationDuration' : 450,
    'maxClusterZoom' : null,
    'noClusterWithOneMarker':true,
    'forceRenderOnZooming' : true
};

export class ClusterLayer extends maptalks.VectorLayer {
    /**
     * Reproduce a ClusterLayer from layer's profile JSON.
     * @param  {Object} json - layer's profile JSON
     * @return {maptalks.ClusterLayer}
     * @static
     * @private
     * @function
     */
    static fromJSON(json) {
        if (!json || json['type'] !== 'ClusterLayer') { return null; }
        const layer = new ClusterLayer(json['id'], json['options']);
        const geoJSONs = json['geometries'];
        const geometries = [];
        for (let i = 0; i < geoJSONs.length; i++) {
            const geo = maptalks.Geometry.fromJSON(geoJSONs[i]);
            if (geo) {
                geometries.push(geo);
            }
        }
        layer.addGeometry(geometries);
        return layer;
    }

    addMarker(markers) {
        return this.addGeometry(markers);
    }

    addGeometry(markers) {
        for (let i = 0, len = markers.length; i <= len; i++) {
            if (!markers[i] instanceof maptalks.Marker) {
                throw new Error('Only a point(Marker) can be added into a ClusterLayer');
            }
        }
        return super.addGeometry.apply(this, arguments);
    }

    onConfig(conf) {
        super.onConfig(conf);
        if (conf['maxClusterRadius'] ||
            conf['symbol'] ||
            conf['drawClusterText'] ||
            conf['textSymbol'] ||
            conf['maxClusterZoom']) {
            const renderer = this._getRenderer();
            if (renderer) {
                renderer.render();
            }
        }
        return this;
    }

    /**
     * Identify the clusters on the given coordinate
     * @param  {maptalks.Coordinate} coordinate   - coordinate to identify
     * @return {Object|Geometry[]}  result: cluster { center : [cluster's center], children : [geometries in the cluster] } or markers
     */
    identify(coordinate, options) {
        const map = this.getMap(),
            maxZoom = this.options['maxClusterZoom'];
        if (maxZoom && map && map.getZoom() > maxZoom) {
            return super.identify(coordinate, options);
        }
        if (this._getRenderer()) {
            return this._getRenderer().identify(coordinate, options);
        }
        return null;
    }

    /**
     * Export the ClusterLayer's JSON.
     * @return {Object} layer's JSON
     */
    toJSON() {
        const json = super.toJSON.call(this);
        json['type'] = 'ClusterLayer';
        return json;
    }
    /**
     * Get the ClusterLayer's current clusters
     * @return {Object} layer's clusters
     **/
    getClusters() {
        const renderer = this._getRenderer();
        if (renderer) {
            return renderer._currentClusters || [];
        }
        return [];
    }
}

// merge to define ClusterLayer's default options.
ClusterLayer.mergeOptions(options);

// register ClusterLayer's JSON type for JSON deserialization.
ClusterLayer.registerJSONType('ClusterLayer');

const defaultTextSymbol = {
    'textFaceName'      : '"microsoft yahei"',
    'textSize'          : 16,
    'textDx'            : 0,
    'textDy'            : 0
};

const defaultSymbol = {
    'markerType' : 'ellipse',
    'markerFill' : { property:'count', type:'interval', stops: [[0, 'rgb(135, 196, 240)'], [9, '#1bbc9b'], [99, 'rgb(216, 115, 149)']] },
    'markerFillOpacity' : 0.7,
    'markerLineOpacity' : 1,
    'markerLineWidth' : 3,
    'markerLineColor' : '#fff',
    'markerWidth' : { property:'count', type:'interval', stops: [[0, 40], [9, 60], [99, 80]] },
    'markerHeight' : { property:'count', type:'interval', stops: [[0, 40], [9, 60], [99, 80]] }
};

ClusterLayer.registerRenderer('canvas', class extends maptalks.renderer.VectorLayerCanvasRenderer {

    constructor(layer) {
        super(layer);
        this._animated = true;
        this._refreshStyle();
        this._clusterNeedRedraw = true;
    }

    checkResources() {
        const symbol = this.layer.options['symbol'] || defaultSymbol;
        const resources = super.checkResources.apply(this, arguments);
        if (symbol !== this._symbolResourceChecked) {
            const res = maptalks.Util.getExternalResources(symbol, true);
            if (res) {
                resources.push.apply(resources, res);
            }
            this._symbolResourceChecked = symbol;
        }
        return resources;
    }

    draw() {
        if (!this.canvas) {
            this.prepareCanvas();
        }
        const map = this.getMap();
        const zoom = map.getZoom();
        const maxClusterZoom = this.layer.options['maxClusterZoom'];
        if (maxClusterZoom &&  zoom > maxClusterZoom) {
            delete this._currentClusters;
            this._markersToDraw = this.layer._geoList;
            super.draw.apply(this, arguments);
            return;
        }
        if (this._clusterNeedRedraw) {
            this._clearDataCache();
            this._computeGrid();
            this._clusterNeedRedraw = false;
        }
        const zoomClusters = this._clusterCache[zoom] ? this._clusterCache[zoom]['clusters'] : null;

        const clusters = this._getClustersToDraw(zoomClusters);
        clusters.zoom = zoom;
        this._drawLayer(clusters);
    }

    _getClustersToDraw(zoomClusters) {
        this._markersToDraw = [];
        const map = this.getMap();
        const font = maptalks.StringUtil.getFont(this._textSymbol),
            digitLen = maptalks.StringUtil.stringLength('9', font).toPoint();
        const extent = map.getContainerExtent(),
            clusters = [];
        let pt, pExt, sprite, width, height;
        for (const p in zoomClusters) {
            this._currentGrid = zoomClusters[p];
            if (zoomClusters[p]['count'] === 1 && this.layer.options['noClusterWithOneMarker']) {
                const marker = zoomClusters[p]['children'][0];
                marker._cluster = zoomClusters[p];
                this._markersToDraw.push(marker);
                continue;
            }
            sprite = this._getSprite();
            width = sprite.canvas.width;
            height = sprite.canvas.height;
            pt = map._prjToContainerPoint(zoomClusters[p]['center']);
            pExt = new maptalks.PointExtent(pt.sub(width, height), pt.add(width, height));
            if (!extent.intersects(pExt)) {
                continue;
            }

            if (!zoomClusters[p]['textSize']) {
                const text = this._getClusterText(zoomClusters[p]);
                zoomClusters[p]['textSize'] = new maptalks.Point(digitLen.x * text.length, digitLen.y)._multi(1 / 2);
            }
            clusters.push(zoomClusters[p]);
        }
        return clusters;
    }

    drawOnInteracting() {
        if (this._currentClusters) {
            this._drawClusters(this._currentClusters, 1);
        }
        super.drawOnInteracting.apply(this, arguments);
    }

    forEachGeo(fn, context) {
        if (this._markersToDraw) {
            this._markersToDraw.forEach((g) => {
                if (context) {
                    fn.call(context, g);
                } else {
                    fn(g);
                }
            });
        }
    }

    onGeometryShow() {
        this._clusterNeedRedraw = true;
        super.onGeometryShow.apply(this, arguments);
    }

    onGeometryHide() {
        this._clusterNeedRedraw = true;
        super.onGeometryHide.apply(this, arguments);
    }

    onGeometryAdd() {
        this._clusterNeedRedraw = true;
        super.onGeometryAdd.apply(this, arguments);
    }

    onGeometryRemove() {
        this._clusterNeedRedraw = true;
        super.onGeometryRemove.apply(this, arguments);
    }

    onGeometryPositionChange() {
        this._clusterNeedRedraw = true;
        super.onGeometryPositionChange.apply(this, arguments);
    }

    onRemove() {
        this._clearDataCache();
    }

    identify(coordinate, options) {
        const map = this.getMap(),
            maxZoom = this.layer.options['maxClusterZoom'];
        if (maxZoom && map.getZoom() > maxZoom) {
            return super.identify(coordinate, options);
        }
        if (this._currentClusters) {
            const point = map.coordinateToContainerPoint(coordinate);
            const old = this._currentGrid;
            for (let i = 0; i < this._currentClusters.length; i++) {
                const c = this._currentClusters[i];
                const pt = map._prjToContainerPoint(c['center']);
                this._currentGrid = c;
                const markerWidth = this._getSprite().canvas.width;

                if (point.distanceTo(pt) <= markerWidth) {
                    return {
                        'center'   : map.getProjection().unproject(c.center.copy()),
                        'children' : c.children.slice(0)
                    };
                }
            }
            this._currentGrid = old;
        }

        // if no clusters is hit, identify markers
        if (this._markersToDraw) {
            return this.layer._hitGeos(this._markersToDraw, coordinate, options);
        }
        return null;
    }

    onSymbolChanged() {
        this._refreshStyle();
        this._computeGrid();
        this._stopAnim();
        this.setToRedraw();
    }

    _refreshStyle() {
        const symbol = this.layer.options['symbol'] || defaultSymbol;
        const textSymbol = this.layer.options['textSymbol'] || defaultTextSymbol;
        const argFn =  () => [this.getMap().getZoom(), this._currentGrid];
        this._symbol = maptalks.MapboxUtil.loadFunctionTypes(symbol, argFn);
        this._textSymbol = maptalks.MapboxUtil.loadFunctionTypes(textSymbol, argFn);
    }

    _drawLayer(clusters) {
        const parentClusters = this._currentClusters || clusters;
        this._currentClusters = clusters;
        delete this._clusterMaskExtent;
        const layer = this.layer;
        //if (layer.options['animation'] && this._animated && this._inout === 'out') {
        if (layer.options['animation'] && this._animated && this._inout) {
            let dr = [0, 1];
            if (this._inout === 'in') {
                dr = [1, 0];
            }
            this._player = maptalks.animation.Animation.animate(
                { 'd' : dr },
                { 'speed' : layer.options['animationDuration'], 'easing' : 'inAndOut' },
                frame => {
                    if (frame.state.playState === 'finished') {
                        this._animated = false;
                        this._drawClusters(clusters, 1);
                        this._drawMarkers();
                        this.completeRender();
                    } else {
                        if (this._inout === 'in') {
                            this._drawClustersFrame(clusters, parentClusters, frame.styles.d);
                        } else {
                            this._drawClustersFrame(parentClusters, clusters, frame.styles.d);
                        }
                        this.setCanvasUpdated();
                    }
                }
            )
            .play();
        } else {
            this._animated = false;
            this._drawClusters(clusters, 1);
            this._drawMarkers();
            this.completeRender();
        }
    }

    _drawMarkers() {
        super.drawGeos(this._clusterMaskExtent);
    }

    _drawClustersFrame(parentClusters, toClusters, ratio) {
        this._clusterMaskExtent = this.prepareCanvas();
        const map = this.getMap(),
            drawn = {};
        if (parentClusters) {
            parentClusters.forEach(c => {
                const p = map._prjToContainerPoint(c['center']);
                if (!drawn[c.key]) {
                    drawn[c.key] = 1;
                    this._drawCluster(p, c, 1 - ratio);
                }
            });
        }
        if (ratio === 0 || !toClusters) {
            return;
        }
        const z = parentClusters.zoom,
            r = map._getResolution(z) * this.layer.options['maxClusterRadius'],
            min = this._markerExtent.getMin();
        toClusters.forEach(c => {
            let pt = map._prjToContainerPoint(c['center']);
            const center = c.center;
            const pgx = Math.floor((center.x - min.x) / r),
                pgy = Math.floor((center.y - min.y) / r);
            const pkey = pgx + '_' + pgy;
            const parent = this._clusterCache[z] ? this._clusterCache[z]['clusterMap'][pkey]: null;
            if (parent) {
                const pp = map._prjToContainerPoint(parent['center']);
                pt = pp.add(pt.sub(pp)._multi(ratio));
            }
            this._drawCluster(pt, c, ratio > 0.5 ? 1 : ratio);
        });
    }

    _drawClusters(clusters, ratio) {
        if (!clusters) {
            return;
        }
        this._clusterMaskExtent = this.prepareCanvas();
        const map = this.getMap();
        clusters.forEach(c => {
            const pt = map._prjToContainerPoint(c['center']);
            this._drawCluster(pt, c, ratio > 0.5 ? 1 : ratio);
        });

    }

    _drawCluster(pt, cluster, op) {
        this._currentGrid = cluster;
        const ctx = this.context;
        const sprite = this._getSprite();
        const opacity = ctx.globalAlpha;
        if (opacity * op === 0) {
            return;
        }
        ctx.globalAlpha = opacity * op;
        if (sprite) {
            const pos = pt.add(sprite.offset)._sub(sprite.canvas.width / 2, sprite.canvas.height / 2);
            ctx.drawImage(sprite.canvas, pos.x, pos.y);
        }

        if (this.layer.options['drawClusterText'] && cluster['textSize']) {
            maptalks.Canvas.prepareCanvasFont(ctx, this._textSymbol);
            ctx.textBaseline = 'middle';
            const dx = this._textSymbol['textDx'] || 0;
            const dy = this._textSymbol['textDy'] || 0;
            const text = this._getClusterText(cluster);
            maptalks.Canvas.fillText(ctx, text, pt.sub(cluster['textSize'].x, 0)._add(dx, dy));
        }
        ctx.globalAlpha = opacity;
    }

    _getClusterText(cluster) {
        const text = this.layer.options['textSumProperty'] ? cluster['textSumProperty'] : cluster['count'];
        return text + '';
    }

    _getSprite() {
        if (!this._spriteCache) {
            this._spriteCache = {};
        }
        const key = maptalks.Util.getSymbolStamp(this._symbol);
        if (!this._spriteCache[key]) {
            this._spriteCache[key] = new maptalks.Marker([0, 0], { 'symbol' : this._symbol })._getSprite(this.resources, this.getMap().CanvasClass);
        }
        return this._spriteCache[key];
    }

    _initGridSystem() {
        const points = [];
        let extent, c;
        this.layer.forEach(g => {
            if (!g.isVisible()) {
                return;
            }
            c = g._getPrjCoordinates();
            if (!extent) {
                extent = g._getPrjExtent();
            } else {
                extent = extent._combine(g._getPrjExtent());
            }
            points.push({
                x : c.x,
                y : c.y,
                id : g._getInternalId(),
                geometry : g
            });
        });
        this._markerExtent = extent;
        this._markerPoints = points;
    }

    _computeGrid() {
        const map = this.getMap(),
            zoom = map.getZoom();
        if (!this._markerExtent) {
            this._initGridSystem();
        }
        if (!this._clusterCache) {
            this._clusterCache = {};
        }
        const pre = map._getResolution(map.getMinZoom()) > map._getResolution(map.getMaxZoom()) ? zoom - 1 : zoom + 1;
        if (this._clusterCache[pre] && this._clusterCache[pre].length === this.layer.getCount()) {
            this._clusterCache[zoom] = this._clusterCache[pre];
        }
        if (!this._clusterCache[zoom]) {
            this._clusterCache[zoom] = this._computeZoomGrid(zoom);
        }
    }

    _computeZoomGrid(zoom) {
        if (!this._markerExtent) {
            return null;
        }
        const map = this.getMap(),
            r = map._getResolution(zoom) * this.layer.options['maxClusterRadius'],
            preT = map._getResolution(zoom - 1) ? map._getResolution(zoom - 1) * this.layer.options['maxClusterRadius'] : null;
        let preCache = this._clusterCache[zoom - 1];
        if (!preCache && zoom - 1 >= map.getMinZoom()) {
            this._clusterCache[zoom - 1] = preCache = this._computeZoomGrid(zoom - 1);
        }
        // 1. format extent of markers to grids with raidus of r
        // 2. find point's grid in the grids
        // 3. sum up the point into the grid's collection
        const points = this._markerPoints;
        const sumProperty = this.layer.options['textSumProperty'];
        const grids = {},
            min = this._markerExtent.getMin();
        let gx, gy, key,
            pgx, pgy, pkey;
        for (let i = 0, len = points.length; i < len; i++) {
            const geo = points[i].geometry;
            let sumProp = 0;

            if (sumProperty && geo.getProperties() && geo.getProperties()[sumProperty]) {
                sumProp = geo.getProperties()[sumProperty];
            }

            gx = Math.floor((points[i].x - min.x) / r);
            gy = Math.floor((points[i].y - min.y) / r);
            key = gx + '_' + gy;
            if (!grids[key]) {
                grids[key] = {
                    'sum' : new maptalks.Coordinate(points[i].x, points[i].y),
                    'center' : new maptalks.Coordinate(points[i].x, points[i].y),
                    'count' : 1,
                    'textSumProperty' : sumProp,
                    'children' :[geo],
                    'key' : key + ''
                };
                if (preT && preCache) {
                    pgx = Math.floor((points[i].x - min.x) / preT);
                    pgy = Math.floor((points[i].y - min.y) / preT);
                    pkey = pgx + '_' + pgy;
                    grids[key]['parent'] = preCache['clusterMap'][pkey];
                }
            } else {

                grids[key]['sum']._add(new maptalks.Coordinate(points[i].x, points[i].y));
                grids[key]['count']++;
                grids[key]['center'] = grids[key]['sum'].multi(1 / grids[key]['count']);
                grids[key]['children'].push(geo);
                grids[key]['textSumProperty'] += sumProp;
            }
        }
        return this._mergeClusters(grids, r / 2);
    }

    _mergeClusters(grids, r) {
        const clusterMap = {};
        for (const p in grids) {
            clusterMap[p] = grids[p];
        }

        // merge adjacent clusters
        const merging = {};

        const visited = {};
        // find clusters need to merge
        let c1, c2;
        for (const p in grids) {
            c1 = grids[p];
            if (visited[c1.key]) {
                continue;
            }
            const gxgy = c1.key.split('_');
            const gx = +(gxgy[0]),
                gy = +(gxgy[1]);
            //traverse adjacent grids
            for (let ii = -1; ii <= 1; ii++) {
                for (let iii = -1; iii <= 1; iii++) {
                    if (ii === 0 && iii === 0) {
                        continue;
                    }
                    const key2 = (gx + ii) + '_' + (gy + iii);
                    c2 = grids[key2];
                    if (c2 && this._distanceTo(c1['center'], c2['center']) <= r) {
                        if (!merging[c1.key]) {
                            merging[c1.key] = [];
                        }
                        merging[c1.key].push(c2);
                        visited[c2.key] = 1;
                    }
                }
            }
        }

        //merge clusters
        for (const m in merging) {
            const grid = grids[m];
            if (!grid) {
                continue;
            }
            const toMerge = merging[m];
            for (let i = 0; i < toMerge.length; i++) {
                if (grids[toMerge[i].key]) {
                    grid['sum']._add(toMerge[i].sum);
                    grid['count'] += toMerge[i].count;
                    grid['textSumProperty'] += toMerge[i].textSumProperty;
                    grid['children'] = grid['children'].concat(toMerge[i].children);
                    clusterMap[toMerge[i].key] = grid;
                    delete grids[toMerge[i].key];
                }
            }
            grid['center'] = grid['sum'].multi(1 / grid['count']);
        }

        return {
            'clusters' : grids,
            'clusterMap' : clusterMap
        };
    }

    _distanceTo(c1, c2) {
        const x = c1.x - c2.x,
            y = c1.y - c2.y;
        return Math.sqrt(x * x + y * y);
    }

    _stopAnim() {
        if (this._player && this._player.playState !== 'finished') {
            this._player.finish();
        }
    }

    onZoomStart(param) {
        this._stopAnim();
        super.onZoomStart(param);
    }

    onZoomEnd(param) {
        if (this.layer.isEmpty() || !this.layer.isVisible()) {
            super.onZoomEnd.apply(this, arguments);
            return;
        }
        this._inout = param['from'] > param['to'] ? 'in' : 'out';
        this._animated = true;
        this._computeGrid();
        super.onZoomEnd.apply(this, arguments);
    }

    _clearDataCache() {
        this._stopAnim();
        delete this._markerExtent;
        delete this._markerPoints;
        delete this._clusterCache;
        delete this._zoomInClusters;
    }
});
