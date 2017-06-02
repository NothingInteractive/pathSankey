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

    // Functions that are going to be declared within the chart, but accessible from the outside to interact with it.
    var activateNodeByAddress;
    var highlightNodeByAddress;
    var resetAllNodes;

    function chart(selection) {

        selection.each(function(data) {

            var parent = d3.select(this);
            var yscale; // not a d3.scale, just a number
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

                            // Defining source and target of each node
                            // (if several outputs for one node, it will be the last one)
                            var from = p;
                            var to = flow.path[i + 1];

                            var source = nodes[from[0]].items[from[1]].items[from[2]];
                            var target = nodes[to[0]].items[to[1]].items[to[2]];

                            target.source = source;
                            source.target = target;
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
                    layer.numGroupSpacings = layer.items.length - 1;
                });

                // yscale calibrated to fill available height according to equation:
                // availableHeight == size*yscale + group_spacing + group_padding + node_spacing
                // (take worst case: smallest value)
                yscale = d3.min(nodes, function(d) {
                    return (availableHeight
                        - d.numGroupSpacings * nodeGroupYSpacing
                        - d.items.filter(function(group) { return group.items.length > 0}).length * nodeGroupYPadding * 2
                        - d.numNodeSpacings * nodeYSpacing) / d.size;
                });

                // compute layer heights by summing all sizes and spacings
                nodes.forEach(function(layer) {
                    layer.totalHeight = layer.size * yscale
                        + layer.numGroupSpacings * nodeGroupYSpacing
                        + layer.items.filter(function(group) { return group.items.length > 0}).length * nodeGroupYPadding * 2
                        + layer.numNodeSpacings * nodeYSpacing;
                });


                // use computed sizes to compute positions of all layers, groups and nodes
                nodes.forEach(function(layer) {
                    var y = 0.5 * (availableHeight - layer.totalHeight) + labelspace.top;
                    layer.y = y;
                    layer.items.forEach(function(group) {

                        group.x = labelspace.left + (availableWidth - nodeWidth) * layer.x;
                        group.y = y;

                        if (group.items.length === 0) {
                            return;
                        }

                        y += nodeGroupYPadding;

                        // Sorting nodes by group of source/target
                        // The `concat()` is to make a copy of the array so that the order stays by nodeIdx otherwise
                        var sortedItems = group.items.concat().sort(function(a, b) {
                            var sortByType = 'target'; // 'source' or 'target'

                            if (a[sortByType] && b[sortByType]) {
                                if (a[sortByType].groupIdx - b[sortByType].groupIdx !== 0) {
                                    return a[sortByType].groupIdx - b[sortByType].groupIdx;
                                }
                                else
                                    return a.nodeIdx - b.nodeIdx;
                            }
                            else {
                                return 0;
                            }
                        });

                        sortedItems.forEach(function(node) {
                            node.x = group.x;
                            node.y = y;
                            y += node.size * yscale;
                            node.height = y - node.y;
                            y += nodeYSpacing;

                            // All nodes in layer that are not the first one should have a source.
                            if (node.layerIdx !== 0 && !node.source) {
                                console.warn('node in column ' + node.layerIdx + ' has no source');
                            }

                            // All nodes in layer that are not the last one should have a target.
                            if (node.layerIdx !== nodes.length - 1 && !node.target) {
                                console.warn('node in column ' + node.layerIdx + ' has no target');
                            }

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
                        y += nodeGroupYPadding;
                        group.height = y - group.y;

                        y += nodeGroupYSpacing;

                    });
                    y -= nodeGroupYSpacing;
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
                        var h = flow.magnitude * yscale;

                        var source = nodes[from[0]].items[from[1]].items[from[2]];
                        var targetGroup = nodes[to[0]].items[to[1]];
                        var target = nodes[to[0]].items[to[1]].items[to[2]];

                        var sourceY0 = source.filledOutY || source.y;
                        var sourceY1 = sourceY0 + h;
                        source.filledOutY = sourceY1;

                        var targetY0 = targetGroup.filledInY || targetGroup.y + nodeGroupYPadding;
                        var targetY1 = targetY0 + h;
                        targetGroup.filledInY = targetY1;


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
                    .style('fill', function(node) {
                        return node.color.brighter(0.5);
                    });
            }

            function resetNodesAppearance(selector) {
                parent.selectAll(selector)
                    .style('fill', function(node) {
                        return node.color;
                    });
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

            highlightNodeByAddress = function(nodeAddress) {
                selectedNodeAddress = nodeAddress;
                var node = data.nodes[selectedNodeAddress[0]]
                    .items[selectedNodeAddress[1]]
                    .items[selectedNodeAddress[2]];
                highlightNodes('.node-' + node.uniqueId);
            };

            resetAllNodes = function() {
                resetNodesAppearance('*[class*=node]');
            };

            /**
             * Highlight all the flows going through the given group
             * @param d
             */
            function activateGroup(d) {
                // Taking layer and group information from first node as it is the same for every node in the group.
                var uniqueGroupId = d.items[0].layerIdx + '-' + d.items[0].groupIdx;

                if (currentlyActiveGroup && currentlyActiveGroup.id === uniqueGroupId) { // Deactivating
                    if (onGroupDeselected) {
                        onGroupDeselected(d);
                    }

                    resetFlowsAppearance('*[class*=passes]');

                    currentlyActiveGroup = undefined;
                    selectedNodeAddress = undefined;
                }
                else { // Activating
                    fadeFlows('*[class*=passes]');
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
                highlightNodes('*[class*=node-' + uniqueGroupId + ']');
            }

            function mouseoutGroup(d) {
                tip.hide(d);
                // Taking layer and group information from first node as it is the same for every node in the group.
                var uniqueGroupId = d.items[0].layerIdx + '-' + d.items[0].groupIdx;
                if (currentlyActiveGroup && currentlyActiveGroup.id === uniqueGroupId) {
                    return;
                }
                resetNodesAppearance('*[class*=node-' + uniqueGroupId + ']');
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

            nodeGroups.append('rect').classed('node-group', true);

            nodeGroups.selectAll('g.node-group > rect')
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

    chart.activateNodeByAddress = function(_) {
        if (!arguments.length) {
            return activateNodeByAddress;
        }
        else {
            return activateNodeByAddress(_);
        }
    };
    chart.highlightNodeByAddress = function(_) {
        if (!arguments.length) {
            return highlightNodeByAddress;
        }
        else {
            return highlightNodeByAddress(_);
        }
    };
    chart.resetAllNodes = function(_) {
        return resetAllNodes();
    };

    return chart;
};

 