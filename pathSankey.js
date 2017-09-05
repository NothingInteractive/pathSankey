d3.pathSankey = function() {

    /*
     Split SVG text into several <tspan> where
     string has newline character \n

     Based on http://bl.ocks.org/mbostock/7555321
     */
    function linebreak(text) {
        text.each(function() {
            var text = d3.select(this),
                words = text.text().split(/\n/).reverse(),
                word,
                lineNumber = 0,
                lineHeight = 1.1, // ems
                y = text.attr('y'),
                x = text.attr('x'),
                dx = text.attr('dx'),
                dy = 0.3 - (words.length - 1) * lineHeight * 0.5; //ems
            text.text(null);
            while (word = words.pop()) {
                tspan = text.append('tspan').attr('dx', dx).attr('x', x).attr('y', y).attr('dy', lineNumber++ * lineHeight + dy + 'em').text(word);
            }
        });
    }


    function prop(p) {
        return function(d) {
            return d[p];
        };
    }

    var width, height; // total width including padding
    var onNodeSelected, onNodeDeselected, onGroupSelected, onGroupDeselected; // callbacks
    var labelspace = {top: 50, left: 30, right: 30, bottom: 0}; // padding around actual sankey
    var selectedNodeAddress = null;

    var nodeYSpacing = 3,
        nodeGroupYSpacing = 0;

    var nodeGroupYPadding = 10;

    var nodeWidth = 30;

    var groupLabelDistance = 5;
    var flowStartWidth = 20; // flows go horizontally for this distance before curving

    var tooltipDirection = 'e';

    var verticalAlign = 'middle';

    var yScale; // not a d3.scale, just a number

    // Functions that are going to be declared within the chart, but accessible from the outside to interact with it.
    var activateNodeByAddress;
    var fadeAllNodesExcept;
    var highlightFlowsByUniqueId;
    var resetAllNodes;
    var highlightAllFlows;
    var fadeAllFlows;
    var resetAllFlows;
    var highlightPortionOfGroup;
    var resetAllPortions;

    function chart(selection) {

        selection.each(function(data) {

            var parent = d3.select(this);
            var currentlyActiveNode = null;
            var currentlyActiveGroup = null;

            var availableWidth = width - (labelspace.right + labelspace.left);
            var availableHeight = height - (labelspace.top + labelspace.bottom);

            var flowAreasData = [];


            /*
             The following anonymous function is used to scope the algorithm for
             preparing the data.

             It computes sizes and positions for all nodes
             and flows and saves them *on* original data structure.

             It does not mutate original data (because then multiple call() would
             destroy the chart.)
             */
            (function() {

                var nodes = data.nodes;
                var flows = data.flows;

                // reset counters from any previous render
                nodes.forEach(function(layer) {
                    layer.size = layer.sizeIn = layer.sizeOut = 0;
                    layer.items.forEach(function(group) {
                        group.size = group.sizeIn = group.sizeOut = 0;
                        group.items.forEach(function(node) {
                            node.size = node.sizeIn = node.sizeOut = 0;
                            node.filledOutY = 0;
                            node.filledInY = 0;
                        });
                    });
                });

                // compute and store sizes of all layers, groups and nodes by counting flows through them
                flows.forEach(function(flow) {
                    flow.path.forEach(function(p, i) {
                        var layer = nodes[p[0]];
                        var nodeGroup = layer.items[p[1]];
                        var node = nodeGroup.items[p[2]];

                        node.layerIdx = p[0];
                        node.groupIdx = p[1];
                        node.nodeIdx = p[2];
                        node.uniqueId = [node.layerIdx, node.groupIdx, node.nodeIdx].join('-');

                        // We also give a sizeIn if we have only one column, in order to have a size
                        if (i > 0 || flow.path.length === 1) {
                            layer.sizeIn += flow.magnitude;
                            nodeGroup.sizeIn += flow.magnitude;
                            node.sizeIn += flow.magnitude;
                        }
                        if (i < flow.path.length - 1) {
                            layer.sizeOut += flow.magnitude;
                            nodeGroup.sizeOut += flow.magnitude;
                            node.sizeOut += flow.magnitude;
                        }
                    });
                });

                nodes.forEach(function(layer) {
                    layer.size = d3.max([layer.sizeIn, layer.sizeOut]);
                    layer.items.forEach(function(group) {
                        group.size = d3.max([group.sizeIn, group.sizeOut]);
                        group.items.forEach(function(node) {
                            node.size = d3.max([node.sizeIn, node.sizeOut]);
                        });
                    });
                });


                nodes.forEach(function(layer) {
                    layer.numNodeSpacings = d3.sum(layer.items, function(g) {
                        return g.items.length - 1;
                    });
                    layer.numGroups = layer.items.filter(function(group) { return group.items.length > 0}).length;
                    layer.numGroupSpacings = layer.numGroups - 1;
                });

                if (!yScale) {
                    // If not manually set:
                    // yScale calibrated to fill available height according to equation:
                    // availableHeight == size*yScale + group_spacing + group_padding + node_spacing
                    // (take worst case: smallest value)
                    yScale = d3.min(nodes, function(d) {
                        return (availableHeight
                            - d.numGroupSpacings * nodeGroupYSpacing
                            - d.numGroups * nodeGroupYPadding * 2
                            - d.numNodeSpacings * nodeYSpacing) / d.size;
                    });
                }

                // compute layer heights by summing all sizes and spacings
                nodes.forEach(function(layer) {
                    layer.totalHeight = layer.size * yScale
                        + layer.numGroupSpacings * nodeGroupYSpacing
                        + layer.numGroups * nodeGroupYPadding * 2
                        + layer.numNodeSpacings * nodeYSpacing;

                    if (verticalAlign === 'spread') {
                        layer.totalHeight = availableHeight;

                        var totalFreeSpace = layer.totalHeight -
                            (layer.size * yScale) -
                            layer.numGroups * nodeGroupYPadding * 2 -
                            layer.numNodeSpacings * nodeYSpacing;

                        layer.nodeGroupYSpacing = totalFreeSpace / layer.numGroupSpacings;
                    }
                    else {
                        layer.nodeGroupYSpacing = nodeGroupYSpacing;
                    }
                });


                // use computed sizes to compute positions of all layers, groups and nodes
                nodes.forEach(function(layer) {
                    var topShiftFactor = 0.5;
                    if (verticalAlign === 'top' || verticalAlign === 'spread') {
                        topShiftFactor = 0;
                    }
                    else if (verticalAlign === 'bottom') {
                        topShiftFactor = 1;
                    }
                    var y = topShiftFactor * (availableHeight - layer.totalHeight) + labelspace.top;
                    layer.y = y;
                    layer.items.forEach(function(group) {

                        group.x = labelspace.left + (availableWidth - nodeWidth) * layer.x;
                        group.y = y;

                        if (group.items.length === 0) {
                            return;
                        }

                        y += nodeGroupYPadding;

                        group.innerY = y;

                        group.items.forEach(function(node) {
                            node.x = group.x;
                            node.y = y;
                            y += node.size * yScale;
                            node.height = y - node.y;
                            y += nodeYSpacing;

                            // convert string colors and set a default color
                            // todo: where should this go?
                            if (node.color.length) {
                                node.color = d3.hsl(node.color);
                            }
                            if (!node.color) {
                                node.color = d3.hsl('#aaa');
                            }
                        });

                        y -= nodeYSpacing;

                        // TODO: innerHeight is actually not used, but might be in the future if the client want to have the portions highlighted from the bottom of the groups
                        group.innerHeight = y - group.innerY;

                        y += nodeGroupYPadding;
                        group.height = y - group.y;

                        y += layer.nodeGroupYSpacing;

                    });
                    y -= layer.nodeGroupYSpacing;
                });


                /*
                 Compute all the path data for the flows.
                 First make a deep copy of the flows data because
                 algorithm is destructive
                 */
                var flowsCopy = data.flows.map(function(f) {
                    var f2 = {magnitude: f.magnitude};
                    f2.extraClasses = f.path.map(function(addr) {
                        return 'passes-' + addr.join('-');
                    }).join(' ');
                    f2.path = f.path.map(function(addr) {
                        return addr.slice(0);
                    });
                    return f2;
                });

                // Compute position of each path
                while (true) {

                    flowsCopy = flowsCopy.filter(function(d) {
                        return d.path.length > 1;
                    });
                    if (flowsCopy.length === 0) {
                        return; // Ends the while (true) loop
                    }

                    flowsCopy.sort(function(a, b) {
                        return a.path[0][0] - b.path[0][0]
                            || a.path[0][1] - b.path[0][1]
                            || a.path[0][2] - b.path[0][2]
                            || a.path[1][0] - b.path[1][0]
                            || a.path[1][1] - b.path[1][1]
                            || a.path[1][2] - b.path[1][2];
                    });

                    var layerIdx = flowsCopy[0].path[0][0];
                    flowsCopy.forEach(function(flow) {

                        if (flow.path[0][0] !== layerIdx) {
                            return;
                        }
                        var from = flow.path[0];
                        var to = flow.path[1];
                        var h = flow.magnitude * yScale;

                        var source = nodes[from[0]].items[from[1]].items[from[2]];
                        var target = nodes[to[0]].items[to[1]].items[to[2]];

                        var sourceY0 = source.filledOutY || source.y;
                        var sourceY1 = sourceY0 + h;
                        source.filledOutY = sourceY1;

                        var targetY0 = target.filledInY || target.y;
                        var targetY1 = targetY0 + h;
                        target.filledInY = targetY1;


                        flowAreasData.push({
                            area: [
                                {x: source.x + nodeWidth, y0: sourceY0, y1: sourceY1},
                                {x: source.x + nodeWidth + flowStartWidth, y0: sourceY0, y1: sourceY1},
                                {x: target.x - flowStartWidth, y0: targetY0, y1: targetY1},
                                {x: target.x, y0: targetY0, y1: targetY1}
                            ],
                            class: [
                                'flow',
                                flow.extraClasses,
                                'from-' + from[0] + '-' + from[1] + '-' + from[2],
                                'to-' + to[0] + '-' + to[1] + '-' + to[2]
                            ].join(' ')
                        });

                        flow.path.shift();
                    });
                }

            })(); // end of data preparation


            // Create all svg elements: layers, groups, nodes and flows.
            var nodeLayers = parent.selectAll('.node-layers')
                .data(prop('nodes'));

            // layer label positioning functions
            layerLabelx = function(d) {
                return labelspace.left + d.x * (availableWidth - nodeWidth) + 0.5 * nodeWidth;
            };
            layerLabely = function() {
                return 0.5 * labelspace.top;
            };
            nodeLayers.enter()
                .append('g').classed('node-layer', true)
                .append('text')
                .attr('class', 'layer-label')
                .attr('text-anchor', 'middle')
                .attr('dx', 0)
                .attr('dy', 0);

            nodeLayers.selectAll('text')
                .attr('x', layerLabelx)
                .attr('y', layerLabely)
                .text(prop('title')).call(linebreak);

            nodeLayers.exit().remove();

            var nodeGroups = nodeLayers.selectAll('g.node-group').data(prop('items'));
            var enteringNodeGroups = nodeGroups.enter().append('g').classed('node-group', true);

            var enteringNodeGroupsG = enteringNodeGroups.append('g').attr('class', 'node-group-label');

            enteringNodeGroupsG.append('path');
            enteringNodeGroupsG.append('text');

            nodeGroups.selectAll('g.node-group > g')
                .style('display', function(d) {
                    return d.label ? '' : 'none';
                });

            // node group label position functions
            nodeGroupLabelx = function(d) {
                return d.x + 0.5 * nodeWidth + 0.5 * d.label * nodeWidth;
            };
            nodeGroupLabely = function(d) {
                return d.y + 0.5 * d.height;
            };
            nodeGroups.selectAll('g.node-group > g > path')
                .filter(function(d) {
                    return d.items.length > 0;
                })
                .attr('d', function(d) {
                    return d3.svg.line()([
                        [nodeGroupLabelx(d) + groupLabelDistance * d.label, d.y + nodeGroupYPadding],
                        [nodeGroupLabelx(d) + groupLabelDistance * d.label, d.y + d.height - nodeGroupYPadding]
                    ]);
                });

            nodeGroups.selectAll('g.node-group > g > text')
                .filter(function(d) {
                    return d.items.length > 0;
                })
                .attr('text-anchor', function(d) {
                    return d.label === -1 ? 'end' : 'start';
                })
                .attr('dx', function(d) {
                    return d.label * (groupLabelDistance * 2);
                })
                .attr('dy', '0.3em')
                .attr('x', nodeGroupLabelx)
                .attr('y', nodeGroupLabely)
                .text(prop('title')).call(linebreak);


            nodeGroups.exit().remove();

            var tip = d3.tip().attr('class', 'd3-tip')
                .direction(tooltipDirection)
                .html(function(d) {
                    return d.size + ' in ' + d.title;
                });
            parent.call(tip);

            var flowElements = parent.selectAll('path.flow').data(flowAreasData);
            flowElements.enter().append('path').attr('class', prop('class'));

            flowElements
                .datum(prop('area'))
                .attr('d',
                    d3.svg.area()
                        .x(prop('x'))
                        .y0(prop('y0'))
                        .y1(prop('y1'))
                        .interpolate('basis'));
            flowElements.exit().remove();

            function highlightFlows(selector) {
                parent.selectAll(selector)
                    .style('fill', function() {
                        var originNodeMatcher = this.className.baseVal.match(/from-(\d+)-(\d+)-(\d+)/);
                        if (originNodeMatcher.length > 1) {
                            var originNode = data.nodes[originNodeMatcher[1]]
                                .items[originNodeMatcher[2]]
                                .items[originNodeMatcher[3]];
                            return originNode.color;
                        }
                        else {
                            return d.color;
                        }
                    })
                    .style('fill-opacity', 0.8);
            }

            function resetFlowsAppearance(selector) {
                parent.selectAll(selector)
                    .style('fill', null)
                    .style('fill-opacity', null);
            }

            function fadeFlows(selector) {
                parent.selectAll(selector)
                    .style('fill', null)
                    .style('fill-opacity', 0.04);
            }

            function highlightNodes(selector) {
                parent.selectAll(selector)
                    .classed('node--highlighted', true);
            }

            function unhighlightNodes(selector) {
                parent.selectAll(selector)
                    .classed('node--highlighted', false);
            }

            function fadeNodes(selector) {
                parent.selectAll(selector)
                    .classed('node--faded', true);
            }

            function resetNodesAppearance(selector) {
                parent.selectAll(selector)
                    .classed('node--highlighted', false)
                    .classed('node--faded', false);
            }


            /**
             * Highlight all the flows going through the given node
             * @param d
             */
            function activateNode(d) {
                var node_id = d.uniqueId;

                if (currentlyActiveNode) {

                    if (onNodeDeselected) {
                        onNodeDeselected(currentlyActiveNode.d);
                    }

                    resetFlowsAppearance('.passes-' + currentlyActiveNode.id);

                    if (currentlyActiveNode.id === node_id) {
                        currentlyActiveNode = selectedNodeAddress = null;
                        return;
                    }
                }

                fadeFlows('*[class*=passes]');
                highlightFlows('.passes-' + node_id);
                resetNodesAppearance('.node-' + node_id);

                currentlyActiveNode = {'id': node_id, 'd': d};
                selectedNodeAddress = node_id.split('-').map(function(d) {
                    return parseInt(d);
                });
                if (onNodeSelected) {
                    onNodeSelected(d);
                }
            }

            activateNodeByAddress = function(nodeAddress) {
                selectedNodeAddress = nodeAddress;
                var node = data.nodes[selectedNodeAddress[0]]
                    .items[selectedNodeAddress[1]]
                    .items[selectedNodeAddress[2]];
                activateNode(node);
            };

            /**
             * @param {string[]} nodesUniqueId
             */
            highlightFlowsByUniqueId = function(nodesUniqueId) {
                fadeFlows('*[class*=passes]');
                nodesUniqueId.forEach(function(nodeUniqueId) {
                    highlightFlows('.passes-' + nodeUniqueId);
                });
            };

            fadeAllNodes = function() {
                fadeNodes('*[class*=node]:not(.node-group):not(.node-layer');
            };

            /**
             * @param {string[]} nodesUniqueId
             */
            fadeAllNodesExcept = function(nodesUniqueId) {
                fadeAllNodes();
                nodesUniqueId.forEach(function(nodeUniqueId) {
                    resetNodesAppearance('.node-' + nodeUniqueId);
                });
            };

            resetAllNodes = function() {
                resetAllPortions();
                resetNodesAppearance('*[class*=node]');
            };

            highlightAllFlows = function() {
                highlightFlows('*[class*=passes]');
            };

            fadeAllFlows = function() {
                fadeFlows('*[class*=passes]');
            };

            resetAllFlows = function() {
                resetFlowsAppearance('*[class*=passes]');
            };

            highlightPortionOfGroup = function(layerIdx, groupIdx, count) {
                nodeGroups.select('#group-portion-' + layerIdx + '-' + groupIdx)
                    .attr('height', function() {
                            return count * yScale;
                        });
            };

            resetAllPortions = function() {
                parent.selectAll('.group-portion')
                    .attr('height', 0);
            };

            /**
             * Highlight all the flows going through the given group
             * @param d
             */
            function activateGroup(d) {
                // Taking layer and group information from first node as it is the same for every node in the group.
                var uniqueGroupId = d.items[0].layerIdx + '-' + d.items[0].groupIdx;

                resetAllPortions();
                resetAllNodes();

                if (currentlyActiveGroup && currentlyActiveGroup.id === uniqueGroupId) { // Deactivating
                    if (onGroupDeselected) {
                        onGroupDeselected(d);
                    }

                    resetAllFlows();

                    currentlyActiveGroup = undefined;
                    selectedNodeAddress = undefined;
                }
                else { // Activating
                    fadeAllFlows();
                    highlightFlows('*[class*=passes-' + uniqueGroupId + ']');
                    resetNodesAppearance('*[class*=node-' + uniqueGroupId + ']');
                    currentlyActiveGroup = {
                        id: uniqueGroupId
                    };

                    if (onGroupSelected) {
                        onGroupSelected(d);
                    }
                }
            }

            function mouseoverNode(d) {
            }

            function mouseoutNode(d) {
            }

            function mouseoverGroup(d) {
                tip.show(d);
                // Taking layer and group information from first node as it is the same for every node in the group.
                var uniqueGroupId = d.items[0].layerIdx + '-' + d.items[0].groupIdx;
                if (currentlyActiveGroup && currentlyActiveGroup.id === uniqueGroupId) {
                    return;
                }
                highlightNodes('*[class*=node-' + uniqueGroupId + '-]');
            }

            function mouseoutGroup(d) {
                tip.hide(d);
                // Taking layer and group information from first node as it is the same for every node in the group.
                var uniqueGroupId = d.items[0].layerIdx + '-' + d.items[0].groupIdx;
                if (currentlyActiveGroup && currentlyActiveGroup.id === uniqueGroupId) {
                    return;
                }
                unhighlightNodes('*[class*=node-' + uniqueGroupId + ']');
            }

            var nodeElements = nodeGroups.selectAll('rect.node').data(prop('items'));
            nodeElements.enter().append('rect').attr('class', function(d) {
                return 'node node-' + d.uniqueId;
            });
            nodeElements
                .attr('x', prop('x'))
                .attr('y', prop('y'))
                .attr('width', nodeWidth)
                .attr('height', prop('height'))
                .style('fill', function(d) {
                    return d.color;
                })
                .on('mouseover', mouseoverNode)
                .on('mouseout', mouseoutNode)
                .on('click', activateNode); // But it cannot be clicked because the group is over it.
            nodeElements.exit().remove();

            nodeGroups
                .attr('id', function(d) {
                    if (d.items && d.items.length > 0) {
                        return 'group-' + d.items[0].layerIdx + '-' + d.items[0].groupIdx;
                    }
                });

            nodeGroups.append('rect')
                .classed('group-portion', true)
                .attr('id', function(d) {
                    if (d.items && d.items.length > 0) {
                        return 'group-portion-' + d.items[0].layerIdx + '-' + d.items[0].groupIdx;
                    }
                })
                .attr('x', prop('x'))
                .attr('y', prop('innerY'))
                .attr('width', nodeWidth)
                .attr('height', 0)
                .style('fill', 'white')
                .style('fill-opacity', 0.5);

            // This rectangle is there only to have the overlay label being centered in the group.
            nodeGroups.append('rect')
                .classed('node-group', true)
                .attr('x', prop('x'))
                .attr('y', prop('y'))
                .attr('width', nodeWidth)
                .attr('height', prop('height'));

            parent.selectAll('g.node-group')
                .on('mouseover', mouseoverGroup)
                .on('mouseout', mouseoutGroup)
                .on('click', activateGroup);

            if (selectedNodeAddress) {
                var node = data.nodes[selectedNodeAddress[0]]
                    .items[selectedNodeAddress[1]]
                    .items[selectedNodeAddress[2]];
                activateNode(node);
            }
        }); // selection.each()
    }


    chart.width = function(_) {
        if (!arguments.length) {
            return width;
        }
        else {
            width = +_;
        }
        return chart;
    };
    chart.height = function(_) {
        if (!arguments.length) {
            return height;
        }
        else {
            height = +_;
        }
        return chart;
    };
    chart.onNodeSelected = function(_) {
        if (!arguments.length) {
            return onNodeSelected;
        }
        else {
            onNodeSelected = _;
        }
        return chart;
    };
    chart.onNodeDeselected = function(_) {
        if (!arguments.length) {
            return onNodeDeselected;
        }
        else {
            onNodeDeselected = _;
        }
        return chart;
    };
    chart.onGroupSelected = function(_) {
        if (!arguments.length) {
            return onGroupSelected;
        }
        else {
            onGroupSelected = _;
        }
        return chart;
    };
    chart.onGroupDeselected = function(_) {
        if (!arguments.length) {
            return onGroupDeselected;
        }
        else {
            onGroupDeselected = _;
        }
        return chart;
    };
    chart.selectedNodeAddress = function(_) {
        if (!arguments.length) {
            return selectedNodeAddress;
        }
        else {
            selectedNodeAddress = _;
        }
        return chart;
    };
    chart.labelSpaceLeft = function(_) {
        if (!arguments.length) {
            return labelspace.left;
        }
        else {
            labelspace.left = _;
        }
        return chart;
    };
    chart.labelSpaceRight = function(_) {
        if (!arguments.length) {
            return labelspace.right;
        }
        else {
            labelspace.right = _;
        }
        return chart;
    };
    chart.nodeYSpacing = function(_) {
        if (!arguments.length) {
            return nodeYSpacing;
        }
        else {
            nodeYSpacing = _;
        }
        return chart;
    };
    chart.nodeGroupYSpacing = function(_) {
        if (!arguments.length) {
            return nodeGroupYSpacing;
        }
        else {
            nodeGroupYSpacing = _;
        }
        return chart;
    };
    chart.nodeGroupYPadding = function(_) {
        if (!arguments.length) {
            return nodeGroupYPadding;
        }
        else {
            nodeGroupYPadding = _;
        }
        return chart;
    };
    chart.tooltipDirection = function(_) {
        if (!arguments.length) {
            return tooltipDirection;
        }
        else {
            tooltipDirection = _;
        }
        return chart;
    };
    chart.verticalAlign = function(_) {
        if (!arguments.length) {
            return verticalAlign;
        }
        else {
            verticalAlign = _;
        }
        return chart;
    };
    chart.yScale = function(_) {
        if (!arguments.length) {
            return yScale;
        }
        else {
            yScale = _;
        }
        return chart;
    };

    chart.activateNodeByAddress = function(_) {
        if (!arguments.length) {
            return activateNodeByAddress;
        }
        else {
            return activateNodeByAddress(_);
        }
    };
    chart.fadeAllNodesExcept = function(_) {
        if (!arguments.length) {
            return fadeAllNodesExcept;
        }
        else {
            return fadeAllNodesExcept(_);
        }
    };
    chart.highlightFlowsByUniqueId = function(_) {
        if (!arguments.length) {
            return highlightFlowsByUniqueId;
        }
        else {
            return highlightFlowsByUniqueId(_);
        }
    };
    chart.highlightPortionOfGroup = function(layerIdx, groupIdx, count) {
        if (arguments.length !== 3) {
            return highlightPortionOfGroup;
        }
        else {
            return highlightPortionOfGroup(layerIdx, groupIdx, count);
        }
    };
    chart.resetAllNodes = function(_) {
        return resetAllNodes();
    };
    chart.highlightAllFlows = function(_) {
        return highlightAllFlows();
    };
    chart.fadeAllFlows = function(_) {
        return fadeAllFlows();
    };
    chart.resetAllFlows = function(_) {
        return resetAllFlows();
    };
    chart.resetAllPortions = function(_) {
        return resetAllPortions();
    };

    return chart;
};

